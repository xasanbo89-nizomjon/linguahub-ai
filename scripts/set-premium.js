"use strict";

// LinguaHub AI - give someone Premium, or take it away (no admin web page).
//
//   node scripts/set-premium.js <email> <days>     Premium for <days> days from now
//   node scripts/set-premium.js <email> 0          remove Premium (back to the free plan)
//
// Uses the same Firebase Admin credentials as the server (FIREBASE_PROJECT_ID,
// FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or GOOGLE_APPLICATION_CREDENTIALS,
// read from .env). The person must have signed in at least once, so that they
// have a Firebase account to find by e-mail. It only sets users/{uid}.plan and
// .premiumUntil; the day's usage count is left alone. Prints what it did.
//
// Exit codes: 0 done, 1 something went wrong (message printed), 2 bad arguments.

const MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE = "Usage: node scripts/set-premium.js <email> <days>\n  <days> = how many days of Premium from now; 0 removes Premium.\n  Example: node scripts/set-premium.js ada@example.com 30";

function parseArguments(argv) {
  const args = argv.slice();
  if (args.length !== 2) return { error: "Expected exactly two arguments: an e-mail address and a number of days." };
  const email = String(args[0]).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "\"" + args[0] + "\" is not a valid e-mail address." };
  const raw = String(args[1]).trim();
  if (!/^\d+$/.test(raw)) return { error: "\"" + args[1] + "\" is not a whole number of days (use 0 to remove Premium)." };
  const days = Number(raw);
  if (days > MAX_DAYS) return { error: "At most " + MAX_DAYS + " days at a time." };
  return { email, days };
}

// deps: { auth, db, timestampFromDate(date), deleteField(), now() }   (the Admin SDK in real use)
async function setPremium(deps, email, days) {
  const now = deps.now ? deps.now() : Date.now();
  let user;
  try {
    user = await deps.auth.getUserByEmail(email);
  } catch (error) {
    if (error && error.code === "auth/user-not-found") {
      const notFound = new Error("No account with the e-mail " + email + ". They need to sign in to LinguaHub once first.");
      notFound.userFacing = true;
      throw notFound;
    }
    throw error;
  }
  const ref = deps.db.collection("users").doc(user.uid);
  if (days > 0) {
    const until = new Date(now + days * DAY_MS);
    await ref.set({ plan: "premium", premiumUntil: deps.timestampFromDate(until) }, { merge: true });
    return { email, uid: user.uid, plan: "premium", premiumUntil: until.toISOString(), days };
  }
  await ref.set({ plan: "free", premiumUntil: deps.deleteField() }, { merge: true });
  return { email, uid: user.uid, plan: "free", premiumUntil: null, days: 0 };
}

function describe(result) {
  if (result.plan === "premium") {
    return ["Premium set for " + result.email + " (" + result.uid + ")", "  plan:          premium", "  premiumUntil:  " + result.premiumUntil + "  (" + result.days + (result.days === 1 ? " day" : " days") + " from now)"];
  }
  return ["Premium removed for " + result.email + " (" + result.uid + ")", "  plan:          free"];
}

// io: { out(line), err(line) }, deps as above; returns the exit code
async function main(argv, deps, io) {
  const parsed = parseArguments(argv);
  if (parsed.error) {
    io.err(parsed.error);
    io.err(USAGE);
    return 2;
  }
  try {
    const result = await setPremium(deps, parsed.email, parsed.days);
    describe(result).forEach((line) => io.out(line));
    return 0;
  } catch (error) {
    if (error && error.userFacing) io.err(error.message);
    else if (error && error.code === "auth/admin-not-configured") io.err("Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY (or GOOGLE_APPLICATION_CREDENTIALS) in .env.");
    else io.err("Could not update the plan: " + (error && error.code ? error.code : error && error.message ? error.message : "unknown error"));
    return 1;
  }
}

if (require.main === module) {
  require("dotenv").config();
  const firebaseAdmin = require("../lib/firebaseAdmin.js");
  const admin = require("firebase-admin");
  const deps = {
    get auth() { return firebaseAdmin.getAuth(); },
    get db() { return firebaseAdmin.getFirestore(); },
    timestampFromDate: (date) => firebaseAdmin.timestampFromDate(date),
    deleteField: () => admin.firestore.FieldValue.delete()
  };
  main(process.argv.slice(2), deps, { out: (line) => console.log(line), err: (line) => console.error(line) }).then((code) => process.exit(code));
}

module.exports = { parseArguments, setPremium, describe, main, MAX_DAYS, USAGE };
