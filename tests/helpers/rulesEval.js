"use strict";

// A small interpreter for the subset of the Firestore security-rules language that
// firestore.rules uses, so the real rules file can be tested without the Firebase
// emulator (which needs firebase-tools and a Java runtime this project does not
// install). It supports: match blocks with {wildcards}, functions, allow statements
// (read / write / get / list / create / update / delete), && || ! == !=, member
// access, list literals and the map / set helpers keys(), diff().affectedKeys(),
// hasAny(), hasAll(), hasOnly(). An expression that errors (e.g. reading a field
// of a missing document) denies, exactly like Firestore.

class RuleError extends Error {}

class RSet {
  constructor(items) { this.items = new Set(items); }
  hasAny(list) { return toList(list).some((v) => this.items.has(v)); }
  hasAll(list) { return toList(list).every((v) => this.items.has(v)); }
  hasOnly(list) { const allowed = new Set(toList(list)); return Array.from(this.items).every((v) => allowed.has(v)); }
}
function toList(value) {
  if (value instanceof RSet) return Array.from(value.items);
  if (Array.isArray(value)) return value;
  throw new RuleError("not a list");
}

function tokenize(source) {
  const tokens = [];
  const re = /\s+|\/\/[^\n]*|(&&|\|\||==|!=|[()[\],.!{};:])|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)/gy;
  let m;
  let last = 0;
  while (last < source.length && (m = re.exec(source))) {
    last = re.lastIndex;
    if (m[1]) tokens.push({ t: "op", v: m[1] });
    else if (m[2]) tokens.push({ t: "str", v: m[2].slice(1, -1) });
    else if (m[3]) tokens.push({ t: "num", v: Number(m[3]) });
    else if (m[4]) tokens.push({ t: "id", v: m[4] });
  }
  if (last < source.length) throw new Error("cannot tokenize near: " + source.slice(last, last + 20));
  return tokens;
}

function parseExpression(tokens, state) {
  const peek = () => tokens[state.i];
  const take = () => tokens[state.i++];
  const isOp = (v) => peek() && peek().t === "op" && peek().v === v;
  function or() { let left = and(); while (isOp("||")) { take(); const right = and(); left = { k: "or", left, right }; } return left; }
  function and() { let left = eq(); while (isOp("&&")) { take(); const right = eq(); left = { k: "and", left, right }; } return left; }
  function eq() {
    const left = unary();
    if (isOp("==") || isOp("!=")) { const op = take().v; const right = unary(); return { k: "eq", op, left, right }; }
    return left;
  }
  function unary() { if (isOp("!")) { take(); return { k: "not", arg: unary() }; } return postfix(); }
  function args() {
    const list = [];
    if (isOp(")")) { take(); return list; }
    for (;;) { list.push(or()); if (isOp(",")) { take(); continue; } if (isOp(")")) { take(); return list; } throw new Error("bad argument list"); }
  }
  function postfix() {
    let node = primary();
    while (isOp(".")) {
      take();
      const name = take().v;
      if (isOp("(")) { take(); node = { k: "call", target: node, name, args: args() }; } else node = { k: "member", target: node, name };
    }
    return node;
  }
  function primary() {
    const t = take();
    if (!t) throw new Error("unexpected end");
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "num") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") { const e = or(); take(); return e; }
    if (t.t === "op" && t.v === "[") {
      const items = [];
      if (isOp("]")) { take(); return { k: "list", items }; }
      for (;;) { items.push(or()); if (isOp(",")) { take(); continue; } take(); return { k: "list", items }; }
    }
    if (t.t === "id") {
      if (t.v === "null") return { k: "lit", v: null };
      if (t.v === "true") return { k: "lit", v: true };
      if (t.v === "false") return { k: "lit", v: false };
      if (isOp("(")) { take(); return { k: "fn", name: t.v, args: args() }; }
      return { k: "var", name: t.v };
    }
    throw new Error("unexpected token " + JSON.stringify(t));
  }
  return or();
}

// The rules file is parsed in two passes: match headers (paths contain "/" which the
// expression tokenizer does not know) are cut out with a regex, the rest is parsed as above.
function loadRules(source) {
  const functions = {};
  const matches = []; // { pattern: ["users", "{userId}"], allows: [{ ops, expr }] }
  const cleaned = source.replace(/\/\/[^\n]*/g, "");
  // functions (top level, before the matches)
  const fnRe = /function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{\s*return\s+([\s\S]*?);\s*\}/g;
  let m;
  while ((m = fnRe.exec(cleaned))) {
    const tokens = tokenize(m[3]);
    functions[m[1]] = { params: m[2].split(",").map((s) => s.trim()).filter(Boolean), body: parseExpression(tokens, { i: 0 }) };
  }
  // match blocks (the innermost ones carry the allow statements)
  const matchRe = /match\s+(\/[^\s{]*(?:\{[^}]+\}[^\s{]*)*)\s*\{/g;
  const starts = [];
  while ((m = matchRe.exec(cleaned))) starts.push({ path: m[1], index: m.index, bodyStart: matchRe.lastIndex });
  starts.forEach((s, idx) => {
    // find the matching closing brace
    let depth = 1;
    let i = s.bodyStart;
    while (i < cleaned.length && depth > 0) { if (cleaned[i] === "{") depth += 1; else if (cleaned[i] === "}") depth -= 1; i += 1; }
    s.body = cleaned.slice(s.bodyStart, i - 1);
  });
  starts.forEach((s) => {
    const segments = s.path.split("/").filter(Boolean);
    if (segments[0] === "databases") return; // the outer wrapper
    const allows = [];
    const allowRe = /allow\s+([a-z,\s]+):\s*if\s+([\s\S]*?);/g;
    let a;
    // only allow statements that belong directly to this match (not to a nested one)
    let body = s.body;
    starts.forEach((other) => { if (other !== s && other.index > s.bodyStart && other.index < s.bodyStart + s.body.length) body = body.replace(other.body, ""); });
    while ((a = allowRe.exec(body))) allows.push({ ops: a[1].split(",").map((x) => x.trim()).filter(Boolean), expr: parseExpression(tokenize(a[2]), { i: 0 }) });
    matches.push({ pattern: segments, allows });
  });
  return { functions, matches };
}

function evaluate(node, scope, functions) {
  switch (node.k) {
    case "lit": return node.v;
    case "list": return node.items.map((n) => evaluate(n, scope, functions));
    case "var":
      if (!(node.name in scope)) throw new RuleError("unknown variable " + node.name);
      return scope[node.name];
    case "not": return !evaluate(node.arg, scope, functions);
    case "and": return evaluate(node.left, scope, functions) && evaluate(node.right, scope, functions);
    case "or": return evaluate(node.left, scope, functions) || evaluate(node.right, scope, functions);
    case "eq": {
      const a = evaluate(node.left, scope, functions);
      const b = evaluate(node.right, scope, functions);
      const same = JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
      return node.op === "==" ? same : !same;
    }
    case "member": {
      const target = evaluate(node.target, scope, functions);
      if (target === null || target === undefined) throw new RuleError("member of null: " + node.name);
      if (!(node.name in target)) throw new RuleError("missing field " + node.name);
      return target[node.name];
    }
    case "fn": {
      const fn = functions[node.name];
      if (!fn) throw new RuleError("unknown function " + node.name);
      const inner = Object.assign({}, scope);
      fn.params.forEach((p, i) => { inner[p] = evaluate(node.args[i], scope, functions); });
      return evaluate(fn.body, inner, functions);
    }
    case "call": {
      const target = evaluate(node.target, scope, functions);
      const args = node.args.map((a) => evaluate(a, scope, functions));
      if (node.name === "keys" && target && typeof target === "object") return new RSet(Object.keys(target));
      if (node.name === "diff" && target && typeof target === "object") {
        const other = args[0] || {};
        return {
          affectedKeys: () => {
            const keys = new Set([...Object.keys(target), ...Object.keys(other)]);
            return new RSet(Array.from(keys).filter((k) => JSON.stringify(target[k]) !== JSON.stringify(other[k])));
          }
        };
      }
      if (node.name === "affectedKeys" && target && typeof target.affectedKeys === "function") return target.affectedKeys();
      if (["hasAny", "hasAll", "hasOnly"].includes(node.name)) {
        const set = target instanceof RSet ? target : new RSet(toList(target));
        return set[node.name](args[0]);
      }
      throw new RuleError("unsupported call " + node.name);
    }
    default: throw new RuleError("bad node");
  }
}

// operations: get | list | create | update | delete   (read = get + list, write = create + update + delete)
function opMatches(ops, operation) {
  return ops.some((op) => op === operation || (op === "read" && (operation === "get" || operation === "list")) || (op === "write" && ["create", "update", "delete"].includes(operation)));
}

// check({ rules, path: "users/u1", operation, auth: { uid } | null, existing: data | null, incoming: data | null })
function check(options) {
  const segments = options.path.split("/").filter(Boolean);
  let allowed = false;
  for (const m of options.rules.matches) {
    if (m.pattern.length !== segments.length) continue;
    const vars = {};
    let ok = true;
    m.pattern.forEach((part, i) => {
      if (part.startsWith("{")) vars[part.slice(1, -1)] = segments[i];
      else if (part !== segments[i]) ok = false;
    });
    if (!ok) continue;
    const scope = Object.assign({}, vars, {
      request: { auth: options.auth || null, resource: options.incoming === undefined || options.incoming === null ? null : { data: options.incoming } },
      resource: options.existing === undefined || options.existing === null ? null : { data: options.existing }
    });
    for (const rule of m.allows) {
      if (!opMatches(rule.ops, options.operation)) continue;
      try {
        if (evaluate(rule.expr, scope, options.rules.functions) === true) allowed = true;
      } catch (error) {
        if (!(error instanceof RuleError)) throw error; // a rule error denies
      }
    }
  }
  return allowed;
}

module.exports = { loadRules, check, RSet, RuleError };
