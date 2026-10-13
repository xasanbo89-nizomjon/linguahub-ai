"use strict";

// Copies the bundled font files from node_modules/@fontsource into
// www/fonts/ (referenced by www/fonts.css). www/ is loaded straight from
// file:// (Electron) and a Capacitor webview, with no bundler, so the
// .woff2 files are committed rather than imported from node_modules.
// Run: node scripts/copy-fonts.js

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "www", "fonts");

const FILES = [
  ["inter", [400, 500, 600, 700], ["latin", "latin-ext"]],
  ["fraunces", [400, 600, 700], ["latin"]]
];

fs.mkdirSync(OUT, { recursive: true });
FILES.forEach(([pkg, weights, subsets]) => {
  const dir = path.join(ROOT, "node_modules", "@fontsource", pkg);
  weights.forEach((w) => subsets.forEach((s) => {
    const name = `${pkg}-${s}-${w}-normal.woff2`;
    fs.copyFileSync(path.join(dir, "files", name), path.join(OUT, name));
  }));
  fs.copyFileSync(path.join(dir, "LICENSE"), path.join(OUT, `LICENSE-${pkg}.txt`));
});
console.log("fonts copied to", OUT);
