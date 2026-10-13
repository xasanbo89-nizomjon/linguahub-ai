"use strict";

// Executes the real www/auth.js and www/app.js source (no rewrite/mock of
// the production code itself) inside a sandboxed vm context with a fake
// `firebase` global and a minimal fake DOM. This avoids adding a browser
// test dependency (no jsdom/puppeteer in this project) while still testing
// the actual shipped source files, not a reimplementation of them.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const AUTH_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "auth.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "www", "app.js"), "utf8");
const ChatStoreModule = require("../www/chatStore.js");
const { createFakeElement: createSharedFakeElement } = require("./helpers/fakeDom");

function createFakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; }
  };
}

// A minimal but real stand-in for www/history-ui.js's public surface, using
// the real chatStore.js repository underneath (not a reimplementation of
// storage logic) - just without the DOM sidebar wiring, which these
// app.js-focused tests don't exercise.
function createFakeHistoryUI() {
  const store = ChatStoreModule.createChatStore({ storage: createFakeLocalStorage() });
  let activeConversationChangedHandler = null;
  let abortFn = null;
  return {
    init() {
      return {
        store,
        onActiveConversationChanged(handler) { activeConversationChangedHandler = handler; },
        registerAbortActiveGeneration(fn) { abortFn = fn; },
        refreshList() {},
        setHistoryStatus() {},
        setUser() {},
        start() {
          const result = store.createConversation();
          if (activeConversationChangedHandler) activeConversationChangedHandler(result.conversation);
        }
      };
    }
  };
}

// ---------------------------------------------------------------------
// www/auth.js
// ---------------------------------------------------------------------

function makeFakeFirebaseAuthInstance() {
  return {
    currentUser: null,
    onAuthStateChanged(onNext) {
      onNext(this.currentUser);
      return () => {};
    },
    signInWithPopup: async () => ({ user: { uid: "popup-user" } }),
    signInWithRedirect: async () => {},
    getRedirectResult: async () => ({ user: null }),
    signOut: async () => {}
  };
}

function buildAuthSandbox({ firebaseAvailable = true, config = { apiKey: "k", projectId: "p", appId: "a" } } = {}) {
  const authInstance = makeFakeFirebaseAuthInstance();
  const authFn = () => authInstance;
  authFn.GoogleAuthProvider = function GoogleAuthProvider() {};

  const fakeFirebase = firebaseAvailable
    ? {
        apps: [],
        initializeApp() {
          fakeFirebase.apps.push({});
        },
        auth: authFn
      }
    : undefined;

  const sandbox = { console, setTimeout, clearTimeout, LINGUAHUB_CONFIG: { FIREBASE: config } };
  sandbox.window = sandbox;
  if (fakeFirebase) sandbox.firebase = fakeFirebase;

  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox, { filename: "auth.js" });

  return { sandbox, authInstance, fakeFirebase };
}

test("auth.js: initializes Firebase exactly once, even if the script were to run twice", () => {
  const { sandbox, fakeFirebase } = buildAuthSandbox();
  assert.equal(fakeFirebase.apps.length, 1);
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), true);

  // Simulate the (accidental) case of the script tag being included twice.
  vm.runInContext(AUTH_SRC, sandbox, { filename: "auth.js" });
  assert.equal(fakeFirebase.apps.length, 1, "must not call firebase.initializeApp a second time");
});

test("auth.js: reports unavailable (guest mode) when Firebase config is missing, without throwing", () => {
  const { sandbox } = buildAuthSandbox({ config: { apiKey: "", projectId: "", appId: "" } });
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), false);
});

test("auth.js: reports unavailable (guest mode) when the Firebase SDK itself failed to load", () => {
  const { sandbox } = buildAuthSandbox({ firebaseAvailable: false });
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), false);
});

test("auth.js: signInWithGoogle rejects with a safe, non-throwing error when unavailable", async () => {
  const { sandbox } = buildAuthSandbox({ firebaseAvailable: false });
  await assert.rejects(() => sandbox.LinguaHubAuth.signInWithGoogle(), (err) => {
    assert.equal(err.code, "sdk-missing");
    assert.match(err.message, /unavailable/i);
    return true;
  });
});

test("auth.js: Google login calls the real Firebase signInWithPopup method", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  let popupCalls = 0;
  authInstance.signInWithPopup = async () => {
    popupCalls += 1;
    return { user: { uid: "real-call-check" } };
  };
  const user = await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.equal(popupCalls, 1);
  assert.equal(user.uid, "real-call-check");
});

// Phase 8, Task 5 (auth error matrix) - popup-blocked/unsupported-environment
// must fall back to a full redirect rather than surfacing a raw error, since
// a real Firebase project isn't configured in this environment and this is
// the only way to exercise that fallback logic without one.
test("auth.js: a blocked popup falls back to signInWithRedirect instead of throwing", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  let redirectCalls = 0;
  authInstance.signInWithPopup = async () => {
    const error = new Error("Popup blocked");
    error.code = "auth/popup-blocked";
    throw error;
  };
  authInstance.signInWithRedirect = async () => { redirectCalls += 1; };

  const result = await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.equal(redirectCalls, 1);
  assert.equal(result, null, "redirect flow has no user yet - completeRedirectSignIn() picks it up next load");
});

test("auth.js: an environment that can't support popups falls back to redirect the same way", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  let redirectCalls = 0;
  authInstance.signInWithPopup = async () => {
    const error = new Error("not supported");
    error.code = "auth/operation-not-supported-in-this-environment";
    throw error;
  };
  authInstance.signInWithRedirect = async () => { redirectCalls += 1; };

  await sandbox.LinguaHubAuth.signInWithGoogle();
  assert.equal(redirectCalls, 1);
});

// Every mapped error code must produce its safe message, never the raw
// Firebase Error object/message/stack - this is the actual security-relevant
// contract (Task 5: "no raw Firebase error object, no stack trace").
test("auth.js: every known Firebase error code maps to its safe user-facing message, never the raw error", async () => {
  // auth/popup-blocked and auth/operation-not-supported-in-this-environment
  // are excluded here on purpose - those fall back to a redirect instead of
  // rejecting (see the dedicated fallback tests above), which is the
  // correct, safe behavior, not a rejection to check messages on.
  const KNOWN_CODES = [
    "auth/popup-closed-by-user",
    "auth/cancelled-popup-request",
    "auth/unauthorized-domain",
    "auth/network-request-failed",
    "auth/admin-restricted-operation"
  ];
  for (const code of KNOWN_CODES) {
    const { sandbox, authInstance } = buildAuthSandbox();
    authInstance.signInWithPopup = async () => {
      const error = new Error(`raw-internal-detail-for-${code}-should-never-surface`);
      error.code = code;
      throw error;
    };
    await assert.rejects(
      () => sandbox.LinguaHubAuth.signInWithGoogle(),
      (err) => {
        assert.equal(err.code, code);
        assert.doesNotMatch(err.message, /raw-internal-detail/, `${code} leaked the raw Firebase error message`);
        assert.doesNotMatch(err.message, /^Error:/, `${code} leaked a raw Error object's default string form`);
        return true;
      }
    );
  }
});

test("auth.js: an unrecognized/unknown Firebase error code still gets a safe generic message, not the raw one", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.signInWithPopup = async () => {
    const error = new Error("some completely novel internal Firebase failure detail");
    error.code = "auth/some-brand-new-code-not-in-our-map";
    throw error;
  };
  await assert.rejects(
    () => sandbox.LinguaHubAuth.signInWithGoogle(),
    (err) => {
      assert.equal(err.message, "Sign-in failed. Please try again.");
      return true;
    }
  );
});

test("auth.js: logout failure is reported as a safe error, not a raw/uncaught exception", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.signOut = async () => {
    const error = new Error("internal-signout-detail-should-not-leak");
    error.code = "auth/internal-error";
    throw error;
  };
  await assert.rejects(
    () => sandbox.LinguaHubAuth.signOutUser(),
    (err) => {
      assert.doesNotMatch(err.message, /internal-signout-detail/);
      return true;
    }
  );
});

test("auth.js: an auth-state-observer error resolves the callback with null instead of leaving it unresolved", () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  let observerErrorHandler;
  authInstance.onAuthStateChanged = (onNext, onError) => {
    observerErrorHandler = onError;
    return () => {};
  };
  let received = "never-called";
  sandbox.LinguaHubAuth.onAuthStateChanged((user) => { received = user; });
  observerErrorHandler(new Error("observer failure"));
  assert.equal(received, null, "an observer error must resolve to signed-out (null), not leave the UI hanging");
});

test("auth.js: logout calls the real Firebase signOut method", async () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  let signOutCalls = 0;
  authInstance.signOut = async () => {
    signOutCalls += 1;
  };
  await sandbox.LinguaHubAuth.signOutUser();
  assert.equal(signOutCalls, 1);
});

test("auth.js: onAuthStateChanged restores the current session state immediately", () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.currentUser = { uid: "restored-user" };
  let received;
  sandbox.LinguaHubAuth.onAuthStateChanged((user) => {
    received = user;
  });
  assert.equal(received.uid, "restored-user");
});

// --- Integration Prep phase: external identity adapter -------------------
// (Task 4 - "shared auth" readiness. Nothing in this repository calls
// provideExternalIdentity() today; these tests exercise the dormant hook
// directly, the same way every other auth.js behavior in this file is
// tested against the real shipped source.)

test("auth.js: with no external adapter provided, behavior is completely unchanged (own Firebase backend)", () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.currentUser = { uid: "own-firebase-user" };
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser().uid, "own-firebase-user");
});

test("auth.js: provideExternalIdentity() makes getCurrentUser() delegate to the adapter, not Firebase", () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.currentUser = { uid: "own-firebase-user" };

  const adapterUser = { uid: "linguahub-host-user", displayName: "Host User", email: "host@example.com" };
  sandbox.LinguaHubAuth.provideExternalIdentity({
    getCurrentUser: () => adapterUser,
    onAuthStateChanged: () => () => {},
    getIdToken: async () => "adapter-issued-token"
  });

  const user = sandbox.LinguaHubAuth.getCurrentUser();
  assert.equal(user.uid, "linguahub-host-user", "must come from the adapter, not the module's own Firebase instance");
});

test("auth.js: provideExternalIdentity() makes isAvailable() report true even when this module's own Firebase config is missing", () => {
  const { sandbox } = buildAuthSandbox({ config: { apiKey: "", projectId: "", appId: "" } });
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), false, "sanity check: unavailable before an adapter is provided");

  sandbox.LinguaHubAuth.provideExternalIdentity({
    getCurrentUser: () => null,
    onAuthStateChanged: () => () => {},
    getIdToken: async () => null
  });
  assert.equal(sandbox.LinguaHubAuth.isAvailable(), true, "identity resolution is available via the adapter, even with no own Firebase config");
});

test("auth.js: provideExternalIdentity() makes onAuthStateChanged() subscribe to the adapter's own observer, not Firebase's", () => {
  const { sandbox } = buildAuthSandbox();
  let adapterCallback = null;
  let unsubscribeCalls = 0;

  sandbox.LinguaHubAuth.provideExternalIdentity({
    getCurrentUser: () => null,
    onAuthStateChanged: (cb) => {
      adapterCallback = cb;
      return () => { unsubscribeCalls += 1; };
    },
    getIdToken: async () => null
  });

  let received;
  const unsubscribe = sandbox.LinguaHubAuth.onAuthStateChanged((user) => { received = user; });
  assert.equal(typeof adapterCallback, "function", "the adapter's own onAuthStateChanged must have been called");

  adapterCallback({ uid: "pushed-by-adapter" });
  assert.equal(received.uid, "pushed-by-adapter");

  unsubscribe();
  assert.equal(unsubscribeCalls, 1, "unsubscribing must call the adapter's own unsubscribe function");
});

test("auth.js: provideExternalIdentity() makes getIdToken() resolve to the adapter's real token, not a fabricated/local one", async () => {
  const { sandbox } = buildAuthSandbox();
  sandbox.LinguaHubAuth.provideExternalIdentity({
    getCurrentUser: () => ({ uid: "u" }),
    onAuthStateChanged: () => () => {},
    getIdToken: async (forceRefresh) => (forceRefresh ? "fresh-adapter-token" : "adapter-token")
  });

  assert.equal(await sandbox.LinguaHubAuth.getIdToken(), "adapter-token");
  assert.equal(await sandbox.LinguaHubAuth.getIdToken(true), "fresh-adapter-token", "forceRefresh must be forwarded to the adapter");
});

test("auth.js: provideExternalIdentity() rejects an incomplete adapter instead of silently accepting a broken one", () => {
  const { sandbox, authInstance } = buildAuthSandbox();
  authInstance.currentUser = { uid: "own-firebase-user" };

  sandbox.LinguaHubAuth.provideExternalIdentity({ getCurrentUser: () => ({ uid: "incomplete" }) });

  // Missing onAuthStateChanged/getIdToken - the adapter must never have
  // been installed, so this module's own Firebase backend is still active.
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser().uid, "own-firebase-user");
});

test("auth.js: provideExternalIdentity() never fabricates a user of its own - it only ever forwards exactly what the adapter itself returns", () => {
  const { sandbox } = buildAuthSandbox();
  sandbox.LinguaHubAuth.provideExternalIdentity({
    getCurrentUser: () => null,
    onAuthStateChanged: () => () => {},
    getIdToken: async () => null
  });
  assert.equal(sandbox.LinguaHubAuth.getCurrentUser(), null, "an adapter reporting no user must never be upgraded into a fake one");
});

test("auth.js and app.js never write a token to localStorage (structural check)", () => {
  // Both files legitimately mention "localStorage" in comments explaining
  // that they deliberately don't use it - check for actual write calls only.
  assert.doesNotMatch(AUTH_SRC, /localStorage\s*[.[]\s*(setItem|['"`]?\w)/);
  assert.doesNotMatch(APP_SRC, /localStorage\s*[.[]\s*(setItem|['"`]?\w)/);
});

// ---------------------------------------------------------------------
// www/app.js
// ---------------------------------------------------------------------

const createFakeElement = createSharedFakeElement;

function makeFakeAuth({ available = true, currentUser = null, token = null } = {}) {
  return {
    isAvailable: () => available,
    getCurrentUser: () => currentUser,
    getIdToken: async () => token,
    completeRedirectSignIn: async () => null,
    onAuthStateChanged: (cb) => {
      cb(currentUser);
      return () => {};
    },
    signInWithGoogle: async () => currentUser,
    signOutUser: async () => {}
  };
}

function makeFakeModeUI() {
  const modes = [
    { id: "general", label: "General AI", description: "", enabled: true, capability: "chat" },
    { id: "codex", label: "Codex AI", description: "", enabled: true, capability: "chat" }
  ];
  return {
    async init() { return { modes, usedFallback: false }; },
    getPromptSuggestions: () => [],
    isSelectableMode: (list, id) => (list || modes).some((m) => m.id === id && m.enabled)
  };
}

async function buildAppSandbox({ fetchImpl, linguaHubAuth }) {
  const ids = [
    "user-input", "chat-box", "send-btn", "status", "status-dot", "mode-select",
    "conversation-title", "empty-state", "empty-state-cards", "scroll-to-bottom-btn", "settings-btn",
    "login-btn", "logout-btn", "user-profile", "user-avatar",
    "user-avatar-fallback", "user-name", "user-email", "auth-status"
  ];
  const elements = {};
  ids.forEach((id) => { elements[id] = createFakeElement(); });
  elements["mode-select"].value = "general";
  elements["mode-select"].options = [{ value: "general" }, { value: "codex" }];

const bodyEl = createFakeElement("body");
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => createFakeElement(tag),
    body: bodyEl
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    document,
    AbortController,
    AbortSignal,
    navigator: { clipboard: { writeText: async () => {} } },
    LINGUAHUB_CONFIG: { apiUrl: (p) => `http://127.0.0.1:3000${p}` },
    LinguaHubAuth: linguaHubAuth,
    LinguaHubChatStore: ChatStoreModule,
    LinguaHubHistoryUI: createFakeHistoryUI(),
    LinguaHubModeUI: makeFakeModeUI()
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
  await sandbox.linguahubReady;

  return { sandbox, elements };
}

function makeFallbackOnlyFetch() {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/chat/stream")) {
      throw new Error("simulated network failure to force the fallback path");
    }
    return { ok: true, status: 200, json: async () => ({ reply: "mock reply" }) };
  };
  return { calls, impl };
}

test("app.js: requests target port 3000 via the centralized config, never port 5500", async () => {
  const { calls, impl } = makeFallbackOnlyFetch();
  const { sandbox, elements } = await buildAppSandbox({ fetchImpl: impl, linguaHubAuth: makeFakeAuth() });
  elements["user-input"].value = "hello";
  await sandbox.sendMessage();
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:3000\//);
    assert.doesNotMatch(call.url, /:5500/);
  }
});

test("app.js: attaches Authorization header when a user is signed in with a token", async () => {
  const { calls, impl } = makeFallbackOnlyFetch();
  const auth = makeFakeAuth({ currentUser: { uid: "u1" }, token: "mock-id-token" });
  const { sandbox, elements } = await buildAppSandbox({ fetchImpl: impl, linguaHubAuth: auth });
  elements["user-input"].value = "hello";
  await sandbox.sendMessage();

  const fallbackCall = calls.find((c) => c.url.includes("/api/chat") && !c.url.includes("/stream"));
  assert.ok(fallbackCall);
  assert.equal(fallbackCall.init.headers.Authorization, "Bearer mock-id-token");
});

test("app.js: never attaches an Authorization header (undefined token) for a guest", async () => {
  const { calls, impl } = makeFallbackOnlyFetch();
  const { sandbox, elements } = await buildAppSandbox({ fetchImpl: impl, linguaHubAuth: makeFakeAuth() });
  elements["user-input"].value = "hello";
  await sandbox.sendMessage();

  const fallbackCall = calls.find((c) => c.url.includes("/api/chat") && !c.url.includes("/stream"));
  assert.ok(fallbackCall);
  assert.equal("Authorization" in fallbackCall.init.headers, false);
});

// Phase 10, Task 7: a failed sign-in attempt must never touch chat
// history - app.js's handleLogin() catch block only sets a status
// message (confirmed by source review); this exercises that
// end-to-end against the real app.js + chatStore.js source.
test("app.js: a failed sign-in attempt does not erase existing guest chat history", async () => {
  const { calls, impl } = makeFallbackOnlyFetch();
  const historyUI = createFakeHistoryUI();
  const auth = {
    isAvailable: () => true,
    getCurrentUser: () => null,
    getIdToken: async () => null,
    completeRedirectSignIn: async () => null,
    onAuthStateChanged: (cb) => { cb(null); return () => {}; },
    signInWithGoogle: async () => { throw { code: "auth/network-request-failed", message: "Network error during sign-in. Check your connection and try again." }; },
    signOutUser: async () => {}
  };

  const ids = [
    "user-input", "chat-box", "send-btn", "status", "status-dot", "mode-select",
    "conversation-title", "empty-state", "empty-state-cards", "scroll-to-bottom-btn", "settings-btn",
    "login-btn", "logout-btn", "user-profile", "user-avatar",
    "user-avatar-fallback", "user-name", "user-email", "auth-status"
  ];
  const elements = {};
  ids.forEach((id) => { elements[id] = createFakeElement(); });
  elements["mode-select"].value = "general";
  elements["mode-select"].options = [{ value: "general" }, { value: "codex" }];
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => createFakeElement(tag),
    body: createFakeElement("body")
  };

  const sandbox = {
    console, setTimeout, clearTimeout, fetch: impl, document,
    AbortController, AbortSignal,
    navigator: { clipboard: { writeText: async () => {} } },
    LINGUAHUB_CONFIG: { apiUrl: (p) => `http://127.0.0.1:3000${p}` },
    LinguaHubAuth: auth,
    LinguaHubChatStore: ChatStoreModule,
    LinguaHubHistoryUI: historyUI,
    LinguaHubModeUI: makeFakeModeUI()
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: "app.js" });
  await sandbox.linguahubReady;

  // A real conversation exists in the guest namespace before the failed
  // login attempt (created by app.js's own startup via historyUI.start()).
  const before = historyUI.init().store.listConversations().length;
  assert.ok(before >= 1, "sanity check: a guest conversation should exist before the failed login attempt");

  await sandbox.handleLogin();
  assert.match(elements["auth-status"].textContent, /network/i, "the failure message reached the UI");

  const after = historyUI.init().store.listConversations().length;
  assert.equal(after, before, "chat history must be unchanged after a failed sign-in attempt");
});

test("app.js: logout aborts an active streaming generation", async () => {
  const calls = [];
  const hangingFetch = (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/api/chat/stream")) {
      return new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ reply: "mock" }) });
  };

  const auth = makeFakeAuth({ currentUser: { uid: "u1" }, token: "mock-id-token" });
  const { sandbox, elements } = await buildAppSandbox({ fetchImpl: hangingFetch, linguaHubAuth: auth });
  elements["user-input"].value = "count to a million";

  const sendPromise = sandbox.sendMessage();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const streamCall = calls.find((c) => c.url.includes("/api/chat/stream"));
  assert.ok(streamCall, "streaming fetch should have started");
  assert.ok(streamCall.init.signal instanceof AbortSignal);
  assert.equal(streamCall.init.signal.aborted, false);

  await sandbox.handleLogout();
  await sendPromise;

  assert.equal(streamCall.init.signal.aborted, true, "logout must abort the in-flight generation");
  // Phase 2: Send is disabled while the composer is empty, so "re-enabled" is
  // now "back from Stop to a normal Send state" (and the composer was never
  // disabled, so it keeps focus and can be typed into).
  assert.equal(elements["send-btn"].textContent, "Send", "the button must leave the Stop state after cancellation");
  assert.equal(elements["send-btn"].classList.contains("is-stop"), false);
  assert.equal(elements["user-input"].disabled, false, "the composer must stay enabled");
});
