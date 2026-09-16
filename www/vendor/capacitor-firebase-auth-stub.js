// LinguaHub AI (Phase 10) - first-party helper, NOT vendored from npm.
//
// vendor/capacitor-firebase-authentication.js (the real, unmodified
// @capacitor-firebase/authentication browser bundle) references a bare
// `firebaseAuthExports` identifier that must already exist as a global
// before it runs. That parameter is only ever read inside the bundle's
// lazy *web-fallback* implementation, which Capacitor's plugin bridge only
// constructs on a non-native platform - www/auth.js only ever calls the
// real native-Android bridge path, so this stub is never functionally
// exercised. It exists solely so the bundle doesn't throw a
// ReferenceError while parsing on load. See docs/capacitor-native-auth.md
// for the full verification (exact source lines showing `auth.*` is only
// touched inside FirebaseAuthenticationWeb's constructor, which is never
// instantiated on native Android).
window.firebaseAuthExports = window.firebaseAuthExports || {};
