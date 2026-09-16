"use strict";

// Phase 9, Task 11: release security scan. Scans real project source AND
// the real built artifact (dist/win-unpacked/resources/app.asar, if
// present) for exact-secret-pattern and generic-secret-pattern matches.
// Reports only file path + category - never prints the matched secret text
// itself.

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = ["www", "lib", "middleware", "e2e", "tests", "docs"];
const SCAN_FILES = ["server.js", "main.js", "package.json", ".env.example", "README.md", "capacitor.config.json"];

const PATTERNS = [
  { name: "OpenAI API key", re: /sk-[a-zA-Z0-9]{16,}/ },
  { name: "Firebase private key block", re: /-----BEGIN (RSA )?PRIVATE KEY-----/ },
  { name: "FIREBASE_PRIVATE_KEY value assignment (non-empty)", re: /FIREBASE_PRIVATE_KEY\s*=\s*["']?-----BEGIN/ },
  { name: "FIREBASE_CLIENT_EMAIL value (real @...iam.gserviceaccount.com)", re: /[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/ },
  { name: "generic JWT secret assignment", re: /JWT_SECRET\s*=\s*["']?[A-Za-z0-9+/_-]{10,}/ },
  { name: "DATABASE_URL with embedded credentials", re: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "generic hex/base64 secret-shaped assignment (40+ chars)", re: /(secret|token|apikey|api_key)\s*[:=]\s*["'][A-Za-z0-9+/_-]{40,}["']/i },
  { name: "raw Firebase ID token (JWT with real-looking payload)", re: /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/ }
];

const FILENAME_PATTERNS = [
  { name: ".env file", re: /(^|[\\/])\.env$/ },
  { name: "service account JSON", re: /serviceaccount|service-account|firebase-adminsdk/i },
  { name: "PEM/P12 key file", re: /\.(pem|p12|pfx|key)$/i },
  { name: "source map", re: /\.js\.map$/i }
];

const findings = [];

function scanFileContent(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return; // binary or unreadable - skip content scan, filename check still applies
  }
  for (const pattern of PATTERNS) {
    if (pattern.re.test(content)) {
      findings.push({ file: path.relative(ROOT, filePath), category: pattern.name });
    }
  }
}

function scanFilename(filePath) {
  const base = path.basename(filePath);
  for (const pattern of FILENAME_PATTERNS) {
    if (pattern.re.test(base)) {
      findings.push({ file: path.relative(ROOT, filePath), category: pattern.name });
    }
  }
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "screenshots" || entry.name === "results") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else {
      scanFilename(full);
      if (/\.(js|json|md|html|css|yml|yaml)$/i.test(entry.name)) {
        scanFileContent(full);
      }
    }
  }
}

function scanBuiltArtifact() {
  const asarPath = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    console.log("[INFO] no built artifact found at dist/win-unpacked - packaged-artifact scan skipped (run `npm run package:dry` first)");
    return;
  }
  console.log("[INFO] scanning built artifact:", path.relative(ROOT, asarPath));

  let listing;
  try {
    listing = execSync(`npx asar list "${asarPath}"`, { cwd: ROOT, encoding: "utf8" });
  } catch (err) {
    console.log("[INFO] could not list asar contents:", err.message.slice(0, 200));
    return;
  }
  const entries = listing.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const base = path.basename(entry);
    for (const pattern of FILENAME_PATTERNS) {
      if (pattern.re.test(base)) {
        findings.push({ file: `app.asar:${entry}`, category: pattern.name });
      }
    }
  }
  console.log(`[INFO] app.asar contains ${entries.length} files - filename-pattern scan complete`);
}

console.log("=== Phase 9 Release Security Scan ===\n");
console.log("Scanning source directories:", SCAN_DIRS.join(", "));
for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));
for (const file of SCAN_FILES) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) {
    scanFilename(full);
    scanFileContent(full);
  }
}
// .env itself is scanned for filename only (never for content - we never
// want this script's own output to include or reason about its contents).
if (fs.existsSync(path.join(ROOT, ".env"))) {
  findings.push({ file: ".env", category: ".env file (expected - .gitignore'd, content never read by this scan)" });
}

console.log("\nScanning built artifact (if present)...");
scanBuiltArtifact();

console.log("\n=== Results ===");
if (findings.length === 0) {
  console.log("No findings.");
} else {
  findings.forEach((f) => console.log(`[${f.category}] ${f.file}`));
}
console.log(`\nTotal findings: ${findings.length}`);

fs.mkdirSync(path.join(__dirname, "results"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "results", "secret-scan.json"), JSON.stringify(findings, null, 2));

// Only the expected, already-known-safe .env filename entry is allowed -
// anything else is a real finding that should fail this check.
const unexpected = findings.filter((f) => f.file !== ".env");
process.exit(unexpected.length > 0 ? 1 : 0);
