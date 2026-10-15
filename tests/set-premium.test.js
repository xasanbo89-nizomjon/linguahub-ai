"use strict";

// node scripts/set-premium.js <email> <days>

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = require("../scripts/set-premium.js");
const usage = require("../lib/usage.js");
const { createFakeFirestore } = require("./helpers/aiAuth.js");

const NOW = Date.parse("2026-03-10T10:00:00Z");
const DELETE = { __delete: true };

// A Firestore whose merge-set understands the field-delete marker, like the real one.
function firestoreWithDelete(initial) {
  const db = createFakeFirestore(initial);
  const collection = db.collection.bind(db);
  db.collection = (name) => {
    const c = collection(name);
    return {
      doc(id) {
        const ref = c.doc(id);
        const set = ref.set.bind(ref);
        ref.set = async (data, options) => {
          const existing = db.read(id) || {};
          const next = Object.assign({}, existing);
          Object.keys(data).forEach((k) => { if (data[k] === DELETE) delete next[k]; else next[k] = data[k]; });
          void set;
          db.records.set(name + "/" + id, { data: next, version: 1 });
          db.log.writes += 1;
        };
        return ref;
      }
    };
  };
  return db;
}

function deps(options) {
  const o = options || {};
  const db = o.db || firestoreWithDelete();
  const accounts = o.accounts || { "ada@example.com": { uid: "uid-ada" }, "bob@example.com": { uid: "uid-bob" } };
  return {
    db,
    auth: {
      async getUserByEmail(email) {
        if (o.authError) throw o.authError;
        if (!accounts[email]) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
        return accounts[email];
      }
    },
    timestampFromDate: (date) => ({ toMillis: () => date.getTime(), toDate: () => date }),
    deleteField: () => DELETE,
    now: () => NOW
  };
}

function run(argv, d) {
  const out = [];
  const err = [];
  return cli.main(argv, d, { out: (l) => out.push(l), err: (l) => err.push(l) }).then((code) => ({ code, out, err }));
}

// ---- arguments --------------------------------------------------------------------------------------------------------

test("arguments: an e-mail address and a whole number of days from 0 to 3650", () => {
  assert.deepEqual(cli.parseArguments(["ada@example.com", "30"]), { email: "ada@example.com", days: 30 });
  assert.deepEqual(cli.parseArguments(["  Ada@Example.COM ", "0"]), { email: "ada@example.com", days: 0 }, "e-mail is trimmed and lower-cased");
  assert.equal(cli.parseArguments(["a@b.co", String(cli.MAX_DAYS)]).days, cli.MAX_DAYS);
});

test("arguments: anything else is refused with a clear message", () => {
  const bad = [
    [], ["ada@example.com"], ["ada@example.com", "30", "extra"],
    ["not-an-email", "30"], ["ada@", "30"], ["@example.com", "30"], ["a b@example.com", "30"], ["", "30"],
    ["ada@example.com", "-5"], ["ada@example.com", "abc"], ["ada@example.com", "2.5"], ["ada@example.com", ""], ["ada@example.com", "1e3"], ["ada@example.com", "0x10"],
    ["ada@example.com", String(cli.MAX_DAYS + 1)], ["ada@example.com", "99999999999999999999"]
  ];
  bad.forEach((argv) => assert.ok(cli.parseArguments(argv).error, JSON.stringify(argv)));
});

test("bad arguments print the usage and exit with code 2 without touching anything", async () => {
  const d = deps();
  const r = await run(["nope"], d);
  assert.equal(r.code, 2);
  assert.match(r.err.join("\n"), /Usage: node scripts\/set-premium\.js <email> <days>/);
  assert.equal(d.db.log.writes, 0);
});

// ---- setting and removing ---------------------------------------------------------------------------------------------

test("set: plan 'premium' and premiumUntil = now + days, and it prints what it did", async () => {
  const d = deps();
  const r = await run(["ada@example.com", "30"], d);
  assert.equal(r.code, 0);
  const saved = d.db.read("uid-ada");
  assert.equal(saved.plan, "premium");
  assert.equal(saved.premiumUntil.toMillis(), NOW + 30 * 86400000);
  const text = r.out.join("\n");
  assert.match(text, /Premium set for ada@example\.com \(uid-ada\)/);
  assert.match(text, /plan:\s+premium/);
  assert.match(text, /premiumUntil:\s+2026-04-09T10:00:00\.000Z\s+\(30 days from now\)/);
  assert.deepEqual(r.err, []);
});

test("set: one day reads '1 day'; the result is premium for the server's own check", async () => {
  const d = deps();
  const r = await run(["bob@example.com", "1"], d);
  assert.match(r.out.join("\n"), /\(1 day from now\)/);
  assert.equal(usage.isPremium(d.db.read("uid-bob"), new Date(NOW + 3600 * 1000)), true);
  assert.equal(usage.isPremium(d.db.read("uid-bob"), new Date(NOW + 25 * 3600 * 1000)), false, "and it ends after that day");
});

test("remove (days = 0): back to the free plan, premiumUntil gone, and it says so", async () => {
  const d = deps({ db: firestoreWithDelete({ "users/uid-ada": { plan: "premium", premiumUntil: { toMillis: () => NOW + 86400000 }, displayName: "Ada" } }) });
  const r = await run(["ada@example.com", "0"], d);
  assert.equal(r.code, 0);
  const saved = d.db.read("uid-ada");
  assert.equal(saved.plan, "free");
  assert.equal("premiumUntil" in saved, false);
  assert.equal(saved.displayName, "Ada", "other profile fields are kept");
  assert.match(r.out.join("\n"), /Premium removed for ada@example\.com/);
  assert.equal(usage.isPremium(saved, new Date(NOW)), false);
});

test("it only touches plan and premiumUntil: the day's usage count is left alone", async () => {
  const d = deps({ db: firestoreWithDelete({ "users/uid-ada": { usageDate: "2026-03-10", usageCount: 8 } }) });
  await run(["ada@example.com", "7"], d);
  assert.deepEqual([d.db.read("uid-ada").usageDate, d.db.read("uid-ada").usageCount], ["2026-03-10", 8]);
  await run(["ada@example.com", "0"], d);
  assert.deepEqual([d.db.read("uid-ada").usageDate, d.db.read("uid-ada").usageCount], ["2026-03-10", 8]);
});

test("setting again replaces the end date (it is 'days from now', not added on)", async () => {
  const d = deps();
  await run(["ada@example.com", "365"], d);
  await run(["ada@example.com", "10"], d);
  assert.equal(d.db.read("uid-ada").premiumUntil.toMillis(), NOW + 10 * 86400000);
});

test("end to end with the daily limit: premium lifts it, removing premium brings it back", async () => {
  const d = deps();
  const db = d.db;
  const at = new Date(NOW);
  for (let i = 0; i < 3; i += 1) await usage.consume({ db, uid: "uid-ada", limit: 3, now: at });
  assert.equal((await usage.consume({ db, uid: "uid-ada", limit: 3, now: at })).allowed, false);
  await run(["ada@example.com", "30"], d);
  assert.equal((await usage.consume({ db, uid: "uid-ada", limit: 3, now: at })).allowed, true);
  await run(["ada@example.com", "0"], d);
  assert.equal((await usage.consume({ db, uid: "uid-ada", limit: 3, now: at })).allowed, false, "free again, and today's allowance was already used");
});

// ---- problems ---------------------------------------------------------------------------------------------------------

test("an unknown e-mail is explained and nothing is written (exit 1)", async () => {
  const d = deps();
  const r = await run(["ghost@example.com", "30"], d);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /No account with the e-mail ghost@example\.com\. They need to sign in to LinguaHub once first\./);
  assert.equal(d.db.log.writes, 0);
});

test("a Firebase problem becomes a short message, never a stack trace (exit 1)", async () => {
  const r = await run(["ada@example.com", "30"], deps({ authError: Object.assign(new Error("secret internals"), { code: "auth/internal-error", stack: "at secret (file.js:1)" }) }));
  assert.equal(r.code, 1);
  const text = r.err.join("\n");
  assert.match(text, /Could not update the plan: auth\/internal-error/);
  assert.doesNotMatch(text, /secret|at .*\.js/);
  const unconfigured = await run(["ada@example.com", "30"], deps({ authError: Object.assign(new Error("x"), { code: "auth/admin-not-configured" }) }));
  assert.match(unconfigured.err.join("\n"), /Firebase Admin is not configured\. Set FIREBASE_PROJECT_ID/);
});

test("a failing write is reported (exit 1), not swallowed", async () => {
  const d = deps();
  const original = d.db.collection;
  d.db.collection = () => ({ doc: () => ({ set: async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); } }) });
  void original;
  const r = await run(["ada@example.com", "30"], d);
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /permission-denied/);
});

// ---- the real command ---------------------------------------------------------------------------------------------------------

function cliProcess(args) {
  const env = Object.assign({}, process.env);
  Object.keys(env).forEach((k) => { if (/^(FIREBASE_|GOOGLE_APPLICATION)/.test(k)) delete env[k]; });
  // a temp folder: dotenv reads ./.env, and the real one must not be used by a test
  return spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "set-premium.js")].concat(args), { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 60000 });
}

test("the real command: bad arguments exit 2 with the usage", () => {
  const r = cliProcess(["only-one-argument"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: node scripts\/set-premium\.js/);
});

test("the real command without Firebase credentials exits 1 with a clear instruction (and does not hang or print a stack)", () => {
  const r = cliProcess(["ada@example.com", "30"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Firebase Admin is not configured/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("it is documented where the owner will look: the README and package scripts mention it, and it needs no extra dependency", () => {
  const readme = require("node:fs").readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /node scripts\/set-premium\.js <email> <days>/);
  const pkg = require("../package.json");
  assert.ok(pkg.dependencies["firebase-admin"] && pkg.dependencies.dotenv, "uses what the server already depends on");
});
