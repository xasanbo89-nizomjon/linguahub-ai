// LinguaHub AI - Firebase Web SDK public configuration.
//
// This is PUBLIC client configuration, not a secret: a Firebase web API key
// only identifies your project to Google's servers, it does not grant
// access by itself. Real access control comes from Firebase Authentication
// + Firebase Security Rules + the "Authorized domains" list in the Firebase
// Console, none of which live here. Never put Firebase Admin / service
// account credentials in this file or anywhere under www/.
//
// Fill these in from: Firebase Console > Project settings > General >
// "Your apps" > Web app > SDK setup and configuration > Config.
//
// Left blank, the app runs in guest-only mode: chat keeps working, and the
// login button reports "Sign-in unavailable" instead of failing silently.

window.LINGUAHUB_CONFIG = window.LINGUAHUB_CONFIG || {};
window.LINGUAHUB_CONFIG.FIREBASE = Object.assign(
{
apiKey: "AIzaSyCAx3-TyjOvSWJRhU-DZpHbkcIovxN6Cpo",
authDomain: "linguahub-ai.firebaseapp.com",
projectId: "linguahub-ai",
appId: "1:1067876278926:web:14434b532d6f9834e3dfdf",
storageBucket: "linguahub-ai.firebasestorage.app",
messagingSenderId: "1067876278926",
measurementId: "G-SJ8H9WR73H"
},
window.LINGUAHUB_CONFIG.FIREBASE || {}
);
