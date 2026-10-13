// LinguaHub AI - safe Markdown rendering for assistant messages.
//
// Pipeline: marked (parse Markdown -> HTML, with a custom fenced-code
// renderer) -> DOMPurify (sanitize the resulting HTML - the actual security
// boundary; marked's own output is never trusted on its own). Both
// libraries are vendored locally (www/vendor/) and loaded as plain
// same-origin <script> tags - no CDN, no bundler, no CSP changes needed
// (script-src 'self' already covers them). See
// docs/phase-05-chat-experience.md ("CSP and dependencies") for why these
// two specific libraries were chosen.
//
// User messages are never run through this - they stay plain text exactly
// as before this phase (unchanged, intentional).
//
// Syntax highlighting is a small hand-rolled tokenizer (below), not a new
// dependency - see "Code blocks" in the docs for the rationale.

var LinguaHubMarkdown = (function () {
"use strict";

// ---------------------------------------------------------------------
// Minimal, dependency-free syntax highlighter.
//
// Deliberately not a full grammar (no huge dependency, per the phase's
// "do not add a huge dependency without justification" rule) - covers the
// common constructs (keywords, strings, comments, numbers) for the
// languages most likely to appear in AI-generated answers. Unknown
// languages fall back to plain (still HTML-escaped) text, never raw HTML.
// ---------------------------------------------------------------------

var KEYWORDS = {
javascript: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "class", "extends", "new", "this", "super", "import", "export", "default", "from", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "static", "get", "set", "yield"],
typescript: null, // filled below (javascript + extras)
python: ["def", "return", "if", "elif", "else", "for", "while", "break", "continue", "class", "import", "from", "as", "try", "except", "finally", "raise", "with", "lambda", "pass", "yield", "global", "nonlocal", "None", "True", "False", "and", "or", "not", "in", "is", "async", "await", "self"],
bash: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "local", "export", "echo", "exit", "in"],
shell: null, // alias for bash
sql: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "AND", "OR", "NOT", "NULL", "AS", "DISTINCT", "LIMIT"],
json: ["true", "false", "null"],
css: ["important", "inherit", "initial", "unset", "auto", "none"],
java: ["public", "private", "protected", "class", "interface", "extends", "implements", "static", "final", "void", "return", "if", "else", "for", "while", "new", "this", "super", "import", "package", "try", "catch", "finally", "throw", "throws", "null", "true", "false"]
};
KEYWORDS.typescript = KEYWORDS.javascript.concat(["interface", "type", "enum", "implements", "namespace", "declare", "readonly", "public", "private", "protected", "as"]);
KEYWORDS.shell = KEYWORDS.bash;
KEYWORDS.ts = KEYWORDS.typescript;
KEYWORDS.js = KEYWORDS.javascript;
KEYWORDS.jsx = KEYWORDS.javascript;
KEYWORDS.tsx = KEYWORDS.typescript;
KEYWORDS.py = KEYWORDS.python;
KEYWORDS.sh = KEYWORDS.bash;

var LANGUAGE_ALIASES = {
js: "javascript", jsx: "javascript", mjs: "javascript",
ts: "typescript", tsx: "typescript",
py: "python", py3: "python",
sh: "bash", shell: "bash", zsh: "bash",
yml: "yaml"
};

function normalizeLang(lang) {
var clean = String(lang || "").trim().toLowerCase();
return LANGUAGE_ALIASES[clean] || clean;
}

function escapeHtml(text) {
return String(text)
.replace(/&/g, "&amp;")
.replace(/</g, "&lt;")
.replace(/>/g, "&gt;")
.replace(/"/g, "&quot;")
.replace(/'/g, "&#39;");
}

// Single linear tokenization pass (comment > string > number > keyword),
// operating on a queue of {text, code} segments so that once a span of
// source text is claimed by an earlier rule it is never re-matched by a
// later one - avoids double-escaping or overlapping <span> tags.
var COMMENT_PATTERNS = {
javascript: [/\/\/[^\n]*/, /\/\*[\s\S]*?\*\//],
typescript: [/\/\/[^\n]*/, /\/\*[\s\S]*?\*\//],
java: [/\/\/[^\n]*/, /\/\*[\s\S]*?\*\//],
css: [/\/\*[\s\S]*?\*\//],
python: [/#[^\n]*/],
bash: [/#[^\n]*/],
sql: [/--[^\n]*/]
};
var STRING_PATTERN = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/;
var NUMBER_PATTERN = /\b\d+(\.\d+)?\b/;

function highlightSegment(code, lang) {
var comments = COMMENT_PATTERNS[lang] || [];
var tokens = [{ text: code, type: "plain" }];

function applyPattern(pattern, type) {
var next = [];
tokens.forEach(function (token) {
if (token.type !== "plain") { next.push(token); return; }
var remaining = token.text;
var lastIndex = 0;
var match;
var re = new RegExp(pattern.source, pattern.flags.indexOf("g") === -1 ? pattern.flags + "g" : pattern.flags);
while ((match = re.exec(remaining)) !== null) {
if (match.index > lastIndex) {
next.push({ text: remaining.slice(lastIndex, match.index), type: "plain" });
}
next.push({ text: match[0], type: type });
lastIndex = match.index + match[0].length;
if (match[0].length === 0) re.lastIndex += 1;
}
if (lastIndex < remaining.length) {
next.push({ text: remaining.slice(lastIndex), type: "plain" });
}
});
tokens = next;
}

comments.forEach(function (p) { applyPattern(p, "comment"); });
applyPattern(STRING_PATTERN, "string");
applyPattern(NUMBER_PATTERN, "number");

var keywords = KEYWORDS[lang];
if (keywords && keywords.length) {
var kwPattern = new RegExp("\\b(" + keywords.join("|") + ")\\b", lang === "sql" ? "g" : "g");
applyPattern(kwPattern, "keyword");
}

return tokens.map(function (t) {
var escaped = escapeHtml(t.text);
if (t.type === "plain") return escaped;
return '<span class="tok-' + t.type + '">' + escaped + "</span>";
}).join("");
}

function highlightCode(code, lang) {
var normalized = normalizeLang(lang);
if (!normalized || !(KEYWORDS[normalized] || COMMENT_PATTERNS[normalized])) {
return escapeHtml(code);
}
try {
return highlightSegment(code, normalized);
} catch (err) {
// Highlighter failure must never break rendering - fall back to safe
// escaped plain text.
return escapeHtml(code);
}
}

// ---------------------------------------------------------------------
// Marked configuration
// ---------------------------------------------------------------------

var markedInstance = null;
var domPurifyInstance = null;

function getMarked() {
if (markedInstance) return markedInstance;
if (typeof window === "undefined" || !window.marked) return null;

var renderer = new window.marked.Renderer();
renderer.code = function (token) {
var text = token && typeof token.text === "string" ? token.text : "";
var lang = normalizeLang(token && token.lang);
var displayLabel = lang || "text";
var highlighted = highlightCode(text, lang);
return (
'<div class="code-block" data-lang="' + escapeHtml(displayLabel) + '">' +
'<div class="code-block-header">' +
'<span class="code-block-lang">' + escapeHtml(displayLabel) + "</span>" +
'<button type="button" class="code-block-copy-btn" aria-label="Copy code">Copy</button>' +
"</div>" +
'<pre><code class="lh-code lang-' + escapeHtml(displayLabel) + '" dir="ltr">' + highlighted + "</code></pre>" +
"</div>"
);
};

window.marked.setOptions({ renderer: renderer, breaks: true, gfm: true });
markedInstance = window.marked;
return markedInstance;
}

var BIDI_BLOCK_TAGS = ["P", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TH", "TD"];

function getDomPurify() {
if (domPurifyInstance) return domPurifyInstance;
if (typeof window === "undefined" || !window.DOMPurify) return null;
var dp = window.DOMPurify;

dp.addHook("afterSanitizeAttributes", function (node) {
if (node.tagName === "A") {
node.setAttribute("target", "_blank");
node.setAttribute("rel", "noopener noreferrer");
}
// Per-block text direction: each paragraph/list/heading/quote/table is laid
// out by its own first strong character, so Arabic and English paragraphs
// in the same reply each read correctly (never a whole-message flip).
// Code stays dir="ltr" (set by the code renderer below).
if (BIDI_BLOCK_TAGS.indexOf(node.tagName) !== -1 && !node.hasAttribute("dir")) {
node.setAttribute("dir", "auto");
}
});

domPurifyInstance = dp;
return domPurifyInstance;
}

var ALLOWED_TAGS = [
"p", "br", "hr", "strong", "em", "del", "code", "pre", "span",
"ul", "ol", "li", "blockquote",
"h1", "h2", "h3", "h4", "h5", "h6",
"table", "thead", "tbody", "tr", "th", "td",
"a", "div", "button"
];
var ALLOWED_ATTR = ["href", "title", "class", "dir", "aria-label", "type", "data-lang", "target", "rel"];

function sanitize(html) {
var dp = getDomPurify();
if (!dp) {
// No sanitizer available (script failed to load): never render
// unsanitized HTML - fall back to escaped plain text instead.
return null;
}
return dp.sanitize(html, {
ALLOWED_TAGS: ALLOWED_TAGS,
ALLOWED_ATTR: ALLOWED_ATTR,
ALLOW_DATA_ATTR: false,
FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "textarea", "svg", "math"],
FORBID_ATTR: ["style", "onerror", "onload", "onclick"]
});
}

function escapeAsPlainText(sourceText) {
return "<p>" + escapeHtml(sourceText).replace(/\n/g, "<br>") + "</p>";
}

function renderToSafeHtml(sourceText) {
var text = typeof sourceText === "string" ? sourceText : "";
if (!text) return "";

var marked = getMarked();
if (!marked) return sanitize(escapeAsPlainText(text)) || escapeHtml(text);

var rawHtml;
try {
rawHtml = marked.parse(text);
} catch (err) {
// Parser failure: preserve readable text rather than losing the
// message or rendering nothing.
rawHtml = escapeAsPlainText(text);
}

var safeHtml = sanitize(rawHtml);
if (safeHtml === null) {
// Sanitizer unavailable - never trust marked's raw output alone.
return escapeHtml(text);
}
return safeHtml;
}

return {
renderToSafeHtml: renderToSafeHtml,
highlightCode: highlightCode,
normalizeLang: normalizeLang,
escapeHtml: escapeHtml
};
})();

if (typeof module !== "undefined" && module.exports) {
module.exports = LinguaHubMarkdown;
}

if (typeof window !== "undefined") {
window.LinguaHubMarkdown = LinguaHubMarkdown;
}
