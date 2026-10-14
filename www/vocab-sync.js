// LinguaHub AI - vocabulary sync (signed-in users only).
//
// Saved words (www/vocab-store.js, localStorage) stay the source of truth and
// work offline. While signed in, each word is also mirrored to Firestore so
// it - and its review schedule - follows the learner to other devices.
//
// Storage: one document per word in `conversation_metadata` (the same
// collection chats use, already covered by firestore.rules: owner-only
// create / read / update / delete), id `<uid>__vocab_<wordId>`, with
// userId === uid and kind === "vocab". Chat sync only reads kind === "chat",
// so the two never see each other's documents. No rules change is needed.
//
// Conflicts: last write wins, by the word's updatedAt (a review, an edit and
// a restore all bump it). Deletions are tombstones (deleted: true). A
// tombstone from another device removes the local word only if this device
// has not changed it since the last sync; a word changed here since then wins
// and is uploaded again. A word that merely vanished locally is never treated
// as a deletion - only deletes reported by the store are propagated.

var LinguaHubVocabSync = (function () {
  "use strict";

  var COLLECTION = "conversation_metadata";
  var FLUSH_DEBOUNCE_MS = 2000;
  var ERROR_RETRY_MS = 30000;
  var VALID_ID = /^[A-Za-z0-9_-]{3,80}$/; // the same rule the store applies to ids

  function docId(uid, wordId) { return uid + "__vocab_" + wordId; }

  function toRemote(uid, word) {
    return {
      userId: uid,
      kind: "vocab",
      wordId: word.id,
      word: word.word,
      translation: word.translation,
      lang: word.lang,
      partOfSpeech: word.partOfSpeech,
      example: word.example,
      exampleTranslation: word.exampleTranslation,
      createdAt: word.createdAt,
      updatedAt: word.updatedAt,
      srs: word.srs,
      deleted: false
    };
  }

  // Anything from the network is untrusted: the store sanitises it again.
  function fromRemote(remote) {
    return {
      id: remote.wordId,
      word: remote.word,
      translation: remote.translation,
      lang: remote.lang,
      partOfSpeech: remote.partOfSpeech,
      example: remote.example,
      exampleTranslation: remote.exampleTranslation,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      srs: remote.srs
    };
  }

  function createFirestoreRemote(getDb) {
    return {
      available: function () { return Boolean(getDb()); },
      listen: function (uid, onDocs, onError) {
        var db = getDb();
        if (!db) return function () {};
        var first = true;
        return db.collection(COLLECTION)
          .where("userId", "==", uid)
          .where("kind", "==", "vocab")
          .onSnapshot(function (snapshot) {
            var docs = [];
            if (first) snapshot.forEach(function (d) { docs.push(d.data()); });
            else snapshot.docChanges().forEach(function (change) { if (change.type !== "removed") docs.push(change.doc.data()); });
            var isInitial = first;
            first = false;
            onDocs(docs, isInitial);
          }, onError);
      },
      write: function (uid, wordId, data) {
        var db = getDb();
        if (!db) return Promise.reject(new Error("no-database"));
        return db.collection(COLLECTION).doc(docId(uid, wordId)).set(data);
      }
    };
  }

  // store: LinguaHubVocab.create() result; remote: see createFirestoreRemote.
  function create(options) {
    var store = options.store;
    var remote = options.remote;
    var storage = options.storage;
    var isOnline = options.isOnline || function () { return true; };
    var clock = options.now || function () { return Date.now(); };
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var flushDelay = typeof options.flushDebounceMs === "number" ? options.flushDebounceMs : FLUSH_DEBOUNCE_MS;

    var uid = null;
    var status = "signed-out";
    var statusListeners = [];
    var state = null; // { synced: {wordId: updatedAt that is in sync}, pendingDeletes: [wordId] }
    var unsubscribeRemote = null;
    var unsubscribeStore = null;
    var flushTimer = null;
    var retryTimer = null;
    var queue = Promise.resolve();
    var running = 0;
    var hadError = false;
    var remoteSeen = false;

    function setStatus(next) {
      if (status === next) return;
      status = next;
      statusListeners.slice().forEach(function (cb) { try { cb(next); } catch (err) { /* ignore */ } });
    }
    function computeStatus() {
      if (!uid) return "signed-out";
      if (!isOnline()) return "offline";
      if (hadError) return "error";
      if (!remoteSeen || running > 0 || state.pendingDeletes.length || flushTimer !== null) return "syncing";
      return "synced";
    }
    function refreshStatus() { setStatus(computeStatus()); }

    function stateKey() { return "linguahub-ai:vocab-sync:" + uid; }
    function loadState() {
      try {
        var parsed = JSON.parse(storage.getItem(stateKey()) || "null");
        if (parsed && typeof parsed === "object") {
          return {
            synced: parsed.synced && typeof parsed.synced === "object" ? parsed.synced : {},
            pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.filter(function (x) { return typeof x === "string"; }) : []
          };
        }
      } catch (err) { /* start fresh */ }
      return { synced: {}, pendingDeletes: [] };
    }
    function saveState() {
      try { storage.setItem(stateKey(), JSON.stringify(state)); } catch (err) { /* non-fatal */ }
    }

    function push(word) {
      var data = toRemote(uid, word);
      return remote.write(uid, word.id, data).then(function () {
        state.synced[word.id] = word.updatedAt;
        return "pushed";
      });
    }

    function pushTombstone(id) {
      var now = clock();
      return remote.write(uid, id, {
        userId: uid, kind: "vocab", wordId: id, word: "", translation: "", lang: "", partOfSpeech: "", example: "", exampleTranslation: "",
        createdAt: new Date(now).toISOString(), updatedAt: now, srs: null, deleted: true, deletedAt: now
      });
    }

    function clearPending(id) {
      state.pendingDeletes = state.pendingDeletes.filter(function (x) { return x !== id; });
    }

    function applyRemote(remoteDoc) {
      var result = store.upsert(fromRemote(remoteDoc));
      if (result && result.ok) { state.synced[remoteDoc.wordId] = result.word.updatedAt; return true; }
      return false;
    }

    // Reconcile one word. `touched.changed` is set when the LOCAL list changed.
    function reconcileOne(id, remoteDoc, touched) {
      var local = store.get(id);
      var syncedAt = state.synced[id];

      if (state.pendingDeletes.indexOf(id) !== -1) {
        if (remoteDoc && remoteDoc.deleted === true) { clearPending(id); delete state.synced[id]; return Promise.resolve(); }
        return pushTombstone(id).then(function () { clearPending(id); delete state.synced[id]; });
      }

      if (remoteDoc && remoteDoc.deleted === true) {
        if (!local) { delete state.synced[id]; return Promise.resolve(); }
        var unchanged = syncedAt !== undefined ? local.updatedAt === syncedAt : local.updatedAt <= Number(remoteDoc.updatedAt || 0);
        if (unchanged) { store.removeSilently(id); delete state.synced[id]; touched.changed = true; return Promise.resolve(); }
        return push(local); // changed here after the last sync: bring it back everywhere
      }

      if (remoteDoc) {
        var remoteAt = Number(remoteDoc.updatedAt) || 0;
        if (!local) {
          if (syncedAt !== undefined) return Promise.resolve(); // known before, gone locally: do not resurrect
          if (applyRemote(remoteDoc)) touched.changed = true;
          return Promise.resolve();
        }
        if (local.updatedAt === remoteAt) { state.synced[id] = remoteAt; return Promise.resolve(); }
        if (remoteAt > local.updatedAt) {
          if (applyRemote(remoteDoc)) touched.changed = true;
          return Promise.resolve();
        }
        return push(local);
      }

      return local ? push(local) : Promise.resolve();
    }

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
      if (touched.changed && typeof store.notifyRemoteChange === "function") {
        try { store.notifyRemoteChange(); } catch (err) { /* UI problems never break sync */ }
      }
      refreshStatus();
    }

    function guard(promise) {
      return promise.catch(function () { hadError = true; scheduleRetry(); });
    }

    function scheduleRetry() {
      if (retryTimer || !uid) return;
      retryTimer = setTimer(function () { retryTimer = null; hadError = false; flush(); }, ERROR_RETRY_MS);
    }

    function onRemoteDocs(docs, isInitial) {
      if (isInitial) remoteSeen = true;
      return guard(runExclusive(function () {
        var touched = { changed: false };
        var byId = {};
        docs.forEach(function (d) { if (d && typeof d.wordId === "string" && VALID_ID.test(d.wordId)) byId[d.wordId] = d; });
        var ids = Object.keys(byId);
        if (isInitial) {
          store.all().forEach(function (w) { if (!byId[w.id]) ids.push(w.id); });
          state.pendingDeletes.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
        }
        var chain = Promise.resolve();
        ids.forEach(function (id) { chain = chain.then(function () { return reconcileOne(id, byId[id], touched); }); });
        return chain.then(function () { hadError = false; settle(touched); });
      }));
    }

    // Push whatever changed locally (and any pending delete). No remote read.
    function flush() {
      if (!uid || !isOnline() || !remoteSeen) { refreshStatus(); return Promise.resolve(); }
      return guard(runExclusive(function () {
        var chain = Promise.resolve();
        state.pendingDeletes.slice().forEach(function (id) { chain = chain.then(function () { return reconcileOne(id, null, { changed: false }); }); });
        store.all().forEach(function (w) {
          if (state.synced[w.id] === w.updatedAt) return;
          chain = chain.then(function () { return push(w); });
        });
        return chain.then(function () { hadError = false; settle({ changed: false }); });
      }));
    }

    function scheduleFlush(delay) {
      if (!uid) return;
      if (flushTimer) clearTimer(flushTimer);
      flushTimer = setTimer(function () { flushTimer = null; flush(); }, typeof delay === "number" ? delay : flushDelay);
    }

    function onStoreEvent(event) {
      if (!uid) return;
      if (event.type === "namespace") {
        // the account changed under us (sign-out / switch): never push another list under this uid
        if (store.getNamespace() !== "user:" + uid) stop();
        return;
      }
      if (event.type === "remote") return; // our own applied changes
      if (event.type === "deleted") {
        if (state.pendingDeletes.indexOf(event.id) === -1) state.pendingDeletes.push(event.id);
        saveState();
      } else if (event.type === "changed" && state.pendingDeletes.indexOf(event.id) !== -1) {
        clearPending(event.id); // a delete that was undone
        saveState();
      }
      refreshStatus();
      scheduleFlush();
    }

    function beginListening() {
      if (unsubscribeRemote || !uid) return;
      unsubscribeRemote = remote.listen(uid, onRemoteDocs, function () {
        hadError = true;
        refreshStatus();
        scheduleRetry();
      });
    }

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
      if (!isOnline()) return;
      beginListening();
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

    function connectivityChanged() {
      if (!uid) return;
      if (isOnline()) {
        hadError = false;
        beginListening();
        flush();
      }
      refreshStatus();
    }

    return {
      start: start,
      stop: stop,
      flush: flush,
      connectivityChanged: connectivityChanged,
      getStatus: function () { return status; },
      onStatusChange: function (cb) {
        statusListeners.push(cb);
        return function () { statusListeners = statusListeners.filter(function (x) { return x !== cb; }); };
      },
      _state: function () { return state; },
      idle: function () { return queue.then(function () {}); }
    };
  }

  return {
    create: create,
    createFirestoreRemote: createFirestoreRemote,
    toRemote: toRemote,
    fromRemote: fromRemote,
    docId: docId,
    COLLECTION: COLLECTION
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubVocabSync;
}

if (typeof window !== "undefined") {
  window.LinguaHubVocabSync = LinguaHubVocabSync;
}
