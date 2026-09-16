"use strict";

// Phase 7 test-only shared result collector: every e2e script pushes
// {name, pass, detail} entries here and calls print()/save() at the end, so
// every script produces the same shape of pass/fail report and a JSON file
// under e2e/results/ that the final documentation is written from directly
// (not from memory/assumption).

const fs = require("node:fs");
const path = require("node:path");

function createResults(label) {
  const entries = [];

  function check(name, pass, detail) {
    entries.push({ name, pass: Boolean(pass), detail: detail || "" });
    const mark = pass ? "PASS" : "FAIL";
    console.log(`[${mark}] ${name}${detail ? " - " + detail : ""}`);
    return Boolean(pass);
  }

  function note(name, detail) {
    entries.push({ name, pass: null, detail: detail || "" });
    console.log(`[INFO] ${name}${detail ? " - " + detail : ""}`);
  }

  function summary() {
    const total = entries.filter((e) => e.pass !== null).length;
    const passed = entries.filter((e) => e.pass === true).length;
    const failed = entries.filter((e) => e.pass === false).length;
    return { total, passed, failed };
  }

  function save(filename) {
    const dir = path.join(__dirname, "results");
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, JSON.stringify({ label, entries, summary: summary() }, null, 2));
    return outPath;
  }

  function printSummary() {
    const s = summary();
    console.log(`\n=== ${label}: ${s.passed}/${s.total} passed, ${s.failed} failed ===\n`);
    return s;
  }

  return { check, note, entries, summary, save, printSummary };
}

module.exports = { createResults };
