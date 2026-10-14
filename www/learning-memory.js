// Per-user learning preferences. Firebase-backed when Firestore is configured;
// guests always stay in localStorage and no sensitive data is collected.
(function () {
"use strict";
var KEY = "linguahub-ai:learning-memory:";
function user() { return window.LinguaHubAuth && window.LinguaHubAuth.getCurrentUser && window.LinguaHubAuth.getCurrentUser(); }
function key() { var current = user(); return KEY + (current && current.uid ? current.uid : "guest"); }
function read() { try { return JSON.parse(localStorage.getItem(key()) || "{}"); } catch (e) { return {}; } }
function firestore() { try { return user() && window.firebase && firebase.apps.length && firebase.firestore ? firebase.firestore() : null; } catch (e) { return null; } }
function write(value) { var safe = { preferredLanguage: value.preferredLanguage || null, learningGoals: Array.isArray(value.learningGoals) ? value.learningGoals.slice(0, 10) : [], weakAreas: Array.isArray(value.weakAreas) ? value.weakAreas.slice(0, 10) : [], tutorModePreference: value.tutorModePreference || null, recentLearningContext: value.recentLearningContext || null, activityDates: Array.isArray(value.activityDates) ? value.activityDates.filter(function (d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }).slice(-400) : [], updatedAt: Date.now() }; localStorage.setItem(key(), JSON.stringify(safe)); var current = user(), db = firestore(); if (!current || !db) return Promise.resolve(safe); return Promise.all([
db.collection("learning_memory").doc(current.uid).set(safe, { merge: true }),
db.collection("user_preferences").doc(current.uid).set({ preferredLanguage: safe.preferredLanguage, tutorModePreference: safe.tutorModePreference, updatedAt: safe.updatedAt }, { merge: true }),
db.collection("users").doc(current.uid).set({ displayName: current.displayName || null, email: current.email || null, updatedAt: safe.updatedAt }, { merge: true })
]).then(function () { return safe; }).catch(function () { return safe; }); }
function clear() { localStorage.removeItem(key()); var current = user(), db = firestore(); return current && db ? db.collection("learning_memory").doc(current.uid).delete().catch(function () {}) : Promise.resolve(); }
function recordTutorUse(mode) { var data = read(); data.tutorModePreference = mode; data.recentLearningContext = { mode: mode, at: Date.now() }; write(data); var current = user(), db = firestore(); if (current && db) db.collection("conversation_metadata").doc(current.uid).set({ userId: current.uid, tutorUsage: firebase.firestore.FieldValue.increment(1), lastTutorMode: mode, updatedAt: Date.now() }, { merge: true }).catch(function () {}); }
function sync() { var current = user(), db = firestore(); if (!current || !db) return function () {}; return db.collection("learning_memory").doc(current.uid).onSnapshot(function (doc) { if (doc.exists) { var remote = doc.data() || {}; remote.activityDates = mergeDays(remote.activityDates, read().activityDates); localStorage.setItem(key(), JSON.stringify(remote)); document.dispatchEvent(new CustomEvent("linguahub:learning-updated")); } }); }
// Learning activity, as local calendar days - the day streak on the home
// screen is derived from these (see www/learning-stats.js). Synced with the
// rest of this document.
function mergeDays(a, b) { return window.LinguaHubLearningStats ? window.LinguaHubLearningStats.mergeDays(a, b) : (a || []).concat(b || []); }
function recordActivity() {
var stats = window.LinguaHubLearningStats;
if (!stats) return;
var data = read();
var days = stats.cleanDays(data.activityDates);
var today = stats.dayKey();
if (days[days.length - 1] === today) return;
days.push(today);
data.activityDates = days.slice(-400);
write(data);
document.dispatchEvent(new CustomEvent("linguahub:learning-updated"));
}
document.addEventListener("linguahub:tutor-message", function (event) { recordTutorUse(event.detail && event.detail.mode || "general"); recordActivity(); });
document.addEventListener("linguahub:activity", recordActivity);
if (window.LinguaHubAuth && window.LinguaHubAuth.onAuthStateChanged) {
window.LinguaHubAuth.onAuthStateChanged(function (current) { if (current) sync(); });
}
window.LinguaHubLearningMemory = { get: read, save: write, clear: clear, sync: sync, recordTutorUse: recordTutorUse, recordActivity: recordActivity, getActivityDates: function () { return (read().activityDates || []).slice(); } };
})();
