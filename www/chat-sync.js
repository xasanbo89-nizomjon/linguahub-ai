// LinguaHub AI - chat sync (signed-in users only).
//
// Local history (www/chatStore.js, localStorage) stays the source of truth
// and always works offline. While signed in, every chat is also mirrored to
// Firestore so it shows up on the user's other devices, and changes made
// there flow back in live.
//
// Storage: one document per chat in `conversation_metadata`, id
// `<uid>__<chatId>`, with userId === uid and kind === "chat". That
// collection is already covered by firestore.rules (owner-only create /
// read / update / delete), so no rules change is needed. Messages are stored
// as one JSON string per chat (Firestore's 1 MiB document limit applies, in
// bytes; a chat larger than that is skipped, never truncated). Thumbs up/down ratings
// are local-only and never uploaded.
//
// Reconciliation is three-way, per chat, against the signature recorded when
// the chat was last in sync (state.synced[id] = { l: local sig, r: remote
// sig }):
//   only local changed  -> push        only remote changed -> apply remote
//   both changed        -> newer updatedAt wins (ties: this device)
// Deletions are tombstones (deleted: true). A tombstone from another device
// removes the local chat ONLY if this device has not changed it since the
// last sync; otherwise the local version wins and is re-uploaded. A chat
// that merely vanishes locally (size pruning) is never treated as a
// deletion - only explicit deletes reported by the store are propagated.

var LinguaHubChatSync = (function () {
  "use strict";

  var COLLECTION = "conversation_metadata";
  // Firestore's limit is 1 MiB of BYTES per document; non-Latin text (Arabic,
  // Cyrillic...) takes 2+ bytes per character, so size is measured in bytes.
  var MAX_DOC_BYTES = 900000;
  var FLUSH_DEBOUNCE_MS = 2000;
  var STREAMING_RECHECK_MS = 3000;
  var ERROR_RETRY_MS = 30000;

  // ---- signatures ----------------------------------------------------------------------

  function hashString(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i += 1) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  // What counts as "the chat changed", independent of updatedAt (pinning does
  // not touch updatedAt) and of local-only fields (ratings).
  function signature(conv) {
    var payload = [
      conv.title, conv.pinned === true, conv.autoTitle !== false,
      conv.metadata && conv.metadata.mode,
      (conv.messages || []).map(function (m) { return [m.id, m.role, m.content, m.status]; })
    ];
    return hashString(JSON.stringify(payload));
  }

  function isStreaming(conv) {
    var last = conv.messages && conv.messages[conv.messages.length - 1];
    return Boolean(last && last.status === "streaming");
  }

  function byteLength(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return text.length * 3; // worst case for UTF-8, when no encoder exists
  }

  function docId(uid, convId) { return uid + "__" + convId; }

  function toRemote(uid, conv) {
    var messages = JSON.stringify((conv.messages || []).map(function (m) {
      return { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, status: m.status };
    }));
    return {
      userId: uid,
      kind: "chat",
      convId: conv.id,
      title: conv.title,
      pinned: conv.pinned === true,
      autoTitle: conv.autoTitle !== false,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      mode: (conv.metadata && conv.metadata.mode) || "general",
      sig: signature(conv),
      deleted: false,
      messages: messages
    };
  }

  function fromRemote(remote) {
    var messages = [];
    try {
      var parsed = JSON.parse(remote.messages || "[]");
      if (Array.isArray(parsed)) messages = parsed;
    } catch (err) { /* a corrupt payload becomes an empty chat, never a crash */ }
    return {
      id: remote.convId,
      title: remote.title,
      pinned: remote.pinned === true,
      autoTitle: remote.autoTitle !== false,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      metadata: { mode: remote.mode },
      messages: messages
    };
  }

  // ---- the Firestore adapter ---------------------------------------------------------------

  // remote = { listen(uid, onDocs, onError) -> unsubscribe, write(uid, convId, data) -> Promise }
  // onDocs(docs, isInitial): docs = array of the remote chat documents that
  // arrived (the whole set the first time, changes afterwards).
  function createFirestoreRemote(getDb) {
    return {
      available: function () { return Boolean(getDb()); },
      listen: function (uid, onDocs, onError) {
        var db = getDb();
        if (!db) return function () {};
        var first = true;
        return db.collection(COLLECTION)
          .where("userId", "==", uid)
          .where("kind", "==", "chat")
          .onSnapshot(function (snapshot) {
            var docs = [];
            if (first) {
              snapshot.forEach(function (d) { docs.push(d.data()); });
            } else {
              snapshot.docChanges().forEach(function (change) {
                if (change.type !== "removed") docs.push(change.doc.data());
              });
            }
            // our own writes echo back before they are confirmed; they are
            // already in sync by construction
            var isInitial = first;
            first = false;
            onDocs(docs, isInitial);
          }, onError);
      },
      write: function (uid, convId, data) {
        var db = getDb();
        if (!db) return Promise.reject(new Error("no-database"));
        return db.collection(COLLECTION).doc(docId(uid, convId)).set(data);
      }
    };
  }

  // ---- the sync engine ---------------------------------------------------------------------

  function create(options) {
    var store = options.store;
    var remote = options.remote;
    var storage = options.storage;
    var isOnline = options.isOnline || function () { return true; };
    var nowIso = options.nowIso || function () { return new Date().toISOString(); };
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var flushDelay = typeof options.flushDebounceMs === "number" ? options.flushDebounceMs : FLUSH_DEBOUNCE_MS;

    var uid = null;
    var status = "signed-out";
    var statusListeners = [];
    var remoteChangeHandler = options.onRemoteChange || function () {};
    var state = null; // { synced: {id: {l, r}}, pendingDeletes: [id] }
    var unsubscribeRemote = null;
    var unsubscribeStore = null;
    var applyingRemote = false;
    var flushTimer = null;
    var retryTimer = null;
    var queue = Promise.resolve();
    var hadError = false;
    var remoteSeen = false; // the first snapshot has arrived (reconciling it may still be in progress)
    // The chat a reply is being generated into right now. chatStore reads
    // every stored "streaming" message back as "stopped", so the data alone
    // cannot say a chat is mid-reply - the app reports it via setGenerating().
    var generatingId = null;

    function isBusyChat(conv) {
      return conv.id === generatingId || isStreaming(conv);
    }

    // ---- status ----
    function setStatus(next) {
      if (status === next) return;
      status = next;
      statusListeners.slice().forEach(function (cb) { try { cb(next); } catch (err) { /* ignore */ } });
    }
    function computeStatus() {
      if (!uid) return "signed-out";
      if (!isOnline()) return "offline";
      if (hadError) return "error";
      // flushTimer === a local change is waiting to be pushed (cheap to know;
      // hashing every chat on every store event would not be)
      if (!remoteSeen || running > 0 || state.pendingDeletes.length || flushTimer !== null) return "syncing";
      return "synced";
    }
    function refreshStatus() { setStatus(computeStatus()); }

    // ---- persisted bookkeeping ----
    function stateKey() { return "linguahub-ai:chat-sync:" + uid; }
    function loadState() {
      var empty = { synced: {}, pendingDeletes: [] };
      try {
        var parsed = JSON.parse(storage.getItem(stateKey()) || "null");
        if (parsed && typeof parsed === "object") {
          return {
            synced: parsed.synced && typeof parsed.synced === "object" ? parsed.synced : {},
            pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.filter(function (x) { return typeof x === "string"; }) : []
          };
        }
      } catch (err) { /* start fresh */ }
      return empty;
    }
    function saveState() {
      try { storage.setItem(stateKey(), JSON.stringify(state)); } catch (err) { /* non-fatal */ }
    }

    function localConversations() { return store.listConversations(); }

    // ---- applying remote state locally (never reported back as a user change) ----
    function applyRemote(remoteDoc) {
      applyingRemote = true;
      try {
        var result = store.upsertConversation(fromRemote(remoteDoc));
        if (result && result.ok) {
          state.synced[remoteDoc.convId] = { l: signature(result.conversation), r: remoteDoc.sig };
          return true;
        }
      } finally { applyingRemote = false; }
      return false;
    }

    function removeLocal(id) {
      applyingRemote = true;
      try { store.deleteConversation(id); } finally { applyingRemote = false; }
      delete state.synced[id];
    }

    // ---- pushing ----
    function push(conv) {
      var data = toRemote(uid, conv);
      if (byteLength(data.messages) > MAX_DOC_BYTES) return Promise.resolve("too-large");
      return remote.write(uid, conv.id, data).then(function () {
        state.synced[conv.id] = { l: data.sig, r: data.sig };
        return "pushed";
      });
    }

    function pushTombstone(id) {
      return remote.write(uid, id, {
        userId: uid, kind: "chat", convId: id, title: "", pinned: false, autoTitle: true,
        createdAt: nowIso(), updatedAt: nowIso(), mode: "general", sig: "deleted",
        deleted: true, deletedAt: nowIso(), messages: "[]"
      });
    }

    // ---- reconcile one chat ----
    // Returns a promise; collects ids whose LOCAL copy changed in `touched`.
    function reconcileOne(id, remoteDoc, touched) {
      var local = store.getConversation(id);
      var base = state.synced[id];
      var wasDeletedHere = state.pendingDeletes.indexOf(id) !== -1;

      if (wasDeletedHere) {
        // This device deleted it: publish the tombstone (unless remote already is one).
        if (remoteDoc && remoteDoc.deleted === true) {
          state.pendingDeletes = state.pendingDeletes.filter(function (x) { return x !== id; });
          delete state.synced[id];
          return Promise.resolve();
        }
        return pushTombstone(id).then(function () {
          state.pendingDeletes = state.pendingDeletes.filter(function (x) { return x !== id; });
          delete state.synced[id];
        });
      }

      if (remoteDoc && remoteDoc.deleted === true) {
        if (!local) { delete state.synced[id]; return Promise.resolve(); }
        var localUnchanged = base && base.l === signature(local);
        if (localUnchanged) { removeLocal(id); touched.push(id); return Promise.resolve(); }
        // edited here after the last sync: keep it and bring it back everywhere
        if (isBusyChat(local)) return Promise.resolve();
        return push(local);
      }

      if (remoteDoc) {
        if (!local) {
          // known before but gone locally (pruned): do not resurrect it
          if (base) return Promise.resolve();
          if (applyRemote(remoteDoc)) touched.push(id);
          return Promise.resolve();
        }
        var localSig = signature(local);
        if (localSig === remoteDoc.sig) { state.synced[id] = { l: localSig, r: remoteDoc.sig }; return Promise.resolve(); }
        if (isBusyChat(local)) return Promise.resolve(); // settle first
        var remoteNewer = Date.parse(remoteDoc.updatedAt) > Date.parse(local.updatedAt);
        if (!base) {
          if (remoteNewer) { if (applyRemote(remoteDoc)) touched.push(id); return Promise.resolve(); }
          return push(local);
        }
        var localChanged = localSig !== base.l;
        var remoteChanged = remoteDoc.sig !== base.r;
        if (!localChanged && !remoteChanged) return Promise.resolve();
        if (!localChanged) { if (applyRemote(remoteDoc)) touched.push(id); return Promise.resolve(); }
        if (!remoteChanged) return push(local);
        if (remoteNewer) { if (applyRemote(remoteDoc)) touched.push(id); return Promise.resolve(); }
        return push(local);
      }

      // no remote document at all
      if (local && !isBusyChat(local)) return push(local);
      return Promise.resolve();
    }

    var running = 0;

    function runExclusive(job) {
      running += 1;
      refreshStatus();
      var result = queue.then(job).then(function (value) {
        running -= 1;
        refreshStatus();
        return value;
      }, function (err) {
        running -= 1;
        hadError = true;
        refreshStatus();
        throw err;
      });
      queue = result.catch(function () {});
      return result;
    }

    function settle(touched) {
      saveState();
      if (touched.length) {
        try { remoteChangeHandler(touched); } catch (err) { /* UI problems never break sync */ }
      }
      refreshStatus();
    }

    function guard(promise) {
      return promise.catch(function () {
        hadError = true;
        scheduleRetry();
      });
    }

    function scheduleRetry() {
      if (retryTimer || !uid) return;
      retryTimer = setTimer(function () { retryTimer = null; hadError = false; flush(); }, ERROR_RETRY_MS);
    }

    // The snapshot listener delivers remote docs; reconcile exactly those
    // (plus, the first time, every local chat the remote has never heard of).
    function onRemoteDocs(docs, isInitial) {
      // Marked on arrival, not on success: if this first reconcile hits a
      // failed upload, flush() must still be able to retry it later.
      if (isInitial) remoteSeen = true;
      return guard(runExclusive(function () {
        var touched = [];
        var byId = {};
        docs.forEach(function (d) { if (d && d.convId) byId[d.convId] = d; });
        var ids = Object.keys(byId);
        if (isInitial) {
          localConversations().forEach(function (c) { if (!byId[c.id]) ids.push(c.id); });
          state.pendingDeletes.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
        }
        var chain = Promise.resolve();
        ids.forEach(function (id) {
          chain = chain.then(function () { return reconcileOne(id, byId[id], touched); });
        });
        return chain.then(function () {
          hadError = false;
          settle(touched);
        });
      }));
    }

    // Push whatever changed locally (and any pending delete). No remote read.
    function flush() {
      if (!uid || !isOnline() || !remoteSeen) { refreshStatus(); return Promise.resolve(); }
      return guard(runExclusive(function () {
        var chain = Promise.resolve();
        var streamingLeft = false;
        state.pendingDeletes.slice().forEach(function (id) {
          chain = chain.then(function () { return reconcileOne(id, null, []); });
        });
        localConversations().forEach(function (c) {
          var base = state.synced[c.id];
          if (base && base.l === signature(c)) return;
          if (isBusyChat(c)) { streamingLeft = true; return; }
          chain = chain.then(function () { return push(c); });
        });
        return chain.then(function () {
          hadError = false;
          settle([]);
          if (streamingLeft) scheduleFlush(STREAMING_RECHECK_MS);
        });
      }));
    }

    function scheduleFlush(delay) {
      if (!uid) return;
      if (flushTimer) clearTimer(flushTimer);
      flushTimer = setTimer(function () { flushTimer = null; flush(); }, typeof delay === "number" ? delay : flushDelay);
    }

    function onStoreEvent(event) {
      if (!uid || applyingRemote) return;
      if (event.type === "deleted") {
        if (state.synced[event.id] && state.pendingDeletes.indexOf(event.id) === -1) state.pendingDeletes.push(event.id);
        saveState();
      } else if (event.type === "cleared") {
        (event.ids || []).forEach(function (id) {
          if (state.synced[id] && state.pendingDeletes.indexOf(id) === -1) state.pendingDeletes.push(id);
        });
        saveState();
      }
      refreshStatus();
      scheduleFlush();
    }

    function onConnectivityChange() {
      if (!uid) return;
      if (isOnline()) {
        hadError = false;
        flush();
      }
      refreshStatus();
    }

    // ---- lifecycle ----
    function start(user) {
      stop();
      if (user && user.uid && !remote.available()) { setStatus("unavailable"); return; }
      if (!user || !user.uid) return;
      uid = user.uid;
      state = loadState();
      hadError = false;
      remoteSeen = false;
      unsubscribeStore = store.subscribe(onStoreEvent);
      refreshStatus();
      if (!isOnline()) return; // resumes on the "online" event via onConnectivityChange()
      beginListening();
    }

    function beginListening() {
      if (unsubscribeRemote || !uid) return;
      unsubscribeRemote = remote.listen(uid, onRemoteDocs, function () {
        hadError = true;
        refreshStatus();
        scheduleRetry();
      });
    }

    function stop() {
      if (unsubscribeRemote) { try { unsubscribeRemote(); } catch (err) { /* ignore */ } unsubscribeRemote = null; }
      if (unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
      if (flushTimer) { clearTimer(flushTimer); flushTimer = null; }
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      uid = null;
      state = null;
      hadError = false;
      remoteSeen = false;
      setStatus("signed-out");
    }

    // The one-time "upload the chats from this device?" offer made right
    // after an account's first sign-in. The answer is remembered per account
    // so it is never asked twice (kept here so app.js never touches storage).
    function offerKey(userId) { return "linguahub-ai:upload-offered:" + userId; }
    function shouldOfferUpload(userId) {
      try { return !storage.getItem(offerKey(userId)); } catch (err) { return false; }
    }
    function recordUploadDecision(userId, uploaded) {
      try { storage.setItem(offerKey(userId), uploaded ? "uploaded" : "declined"); } catch (err) { /* non-fatal */ }
    }

    // The app reports which chat is being generated into (null when none).
    // That chat is neither uploaded nor overwritten until the reply settles.
    function setGenerating(convId) {
      generatingId = convId || null;
      if (!generatingId && uid) scheduleFlush();
    }

    function connectivityChanged() {
      if (uid && isOnline() && !unsubscribeRemote) beginListening();
      onConnectivityChange();
    }

    return {
      start: start,
      stop: stop,
      flush: flush,
      setGenerating: setGenerating,
      shouldOfferUpload: shouldOfferUpload,
      recordUploadDecision: recordUploadDecision,
      connectivityChanged: connectivityChanged,
      getStatus: function () { return status; },
      onStatusChange: function (cb) {
        statusListeners.push(cb);
        return function () { statusListeners = statusListeners.filter(function (x) { return x !== cb; }); };
      },
      // test / diagnostics hooks
      _state: function () { return state; },
      // resolves once everything queued so far has finished
      idle: function () { return queue.then(function () {}); }
    };
  }

  var STATUS_TEXT = {
    "signed-out": "",
    syncing: "Syncing\u2026",
    synced: "Synced",
    offline: "Offline \u2013 saved on this device",
    error: "Sync problem \u2013 will retry",
    unavailable: "Sync unavailable"
  };

  function statusText(status) {
    return Object.prototype.hasOwnProperty.call(STATUS_TEXT, status) ? STATUS_TEXT[status] : "";
  }

  // The wording of the one-time "upload what is on this device?" dialog,
  // for the chats and/or saved words made while signed out.
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function uploadOffer(chatCount, wordCount) {
    var parts = [];
    if (chatCount > 0) parts.push(plural(chatCount, "chat", "chats"));
    if (wordCount > 0) parts.push(plural(wordCount, "saved word", "saved words"));
    var total = chatCount + wordCount;
    var title = chatCount > 0 && wordCount > 0 ? "Upload your chats and words?" : chatCount > 0 ? "Upload your chats?" : "Upload your words?";
    return {
      title: title,
      message: "You have " + parts.join(" and ") + " on this device from before you signed in. Upload " + (total === 1 ? "it" : "them") + " to your account so " + (total === 1 ? "it appears" : "they appear") + " on your other devices too?",
      confirmLabel: "Yes, upload",
      cancelLabel: "No"
    };
  }

  function uploadedToast(chatsAdded, wordsAdded) {
    var parts = [];
    if (chatsAdded > 0) parts.push(plural(chatsAdded, "chat", "chats"));
    if (wordsAdded > 0) parts.push(plural(wordsAdded, "word", "words"));
    return parts.length ? "Uploaded " + parts.join(" and ") + " to your account." : "";
  }

  return {
    uploadOffer: uploadOffer,
    uploadedToast: uploadedToast,
    statusText: statusText,
    create: create,
    createFirestoreRemote: createFirestoreRemote,
    signature: signature,
    toRemote: toRemote,
    fromRemote: fromRemote,
    docId: docId,
    MAX_DOC_BYTES: MAX_DOC_BYTES
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubChatSync;
}

if (typeof window !== "undefined") {
  window.LinguaHubChatSync = LinguaHubChatSync;
}
