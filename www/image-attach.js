// LinguaHub AI - pictures in the composer.
//
// Attach with the "+" button, paste (Ctrl+V) or drag and drop: PNG, JPEG or
// WebP, up to 4 per message. Every picture is shrunk in the browser first
// (longest side 1600 px, re-encoded as JPEG to about 1 MB or less - less when
// several are attached, so the whole request stays under Vercel's 4.5 MB body
// limit; the server re-checks everything, see lib/images.js). Thumbnails sit
// above the composer with remove (x) buttons; a sent picture can be clicked
// to enlarge.
//
// Pictures are never stored: they live in memory until the reply is done
// (and for Retry during the session). History and sync only keep an
// "[image]" placeholder line for each picture (storedContent / splitStored).

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") root.LinguaHubImages = api;
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  var ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
  var MAX_IMAGES = 4;
  var MAX_SIDE = 1600;
  var MAX_IMAGE_BYTES = 1024 * 1024;
  var TOTAL_BUDGET_BYTES = Math.floor(2.8 * 1024 * 1024); // the server accepts 3.0 MB in total
  var VISION_MODES = ["general", "translate"];
  var MARKER = "[image]";
  var SESSION_LIMIT = 12;

  // ---- pure helpers -------------------------------------------------------------------------

  function budgetPerImage(count) {
    return Math.min(MAX_IMAGE_BYTES, Math.floor(TOTAL_BUDGET_BYTES / Math.max(1, count)));
  }

  function fitSize(width, height, maxSide) {
    var longest = Math.max(width, height);
    if (!(longest > 0)) return { width: 0, height: 0 };
    if (longest <= maxSide) return { width: width, height: height };
    var scale = maxSide / longest;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  // decoded size of a base64 data URL
  function dataUrlBytes(url) {
    var comma = String(url).indexOf(",");
    if (comma < 0) return 0;
    var body = url.slice(comma + 1);
    var padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.floor((body.length * 3) / 4) - padding;
  }

  function isAcceptedType(type) {
    return ACCEPTED_TYPES.indexOf(String(type || "").toLowerCase()) !== -1;
  }

  // What is kept in history for a message that had pictures: its text, then one
  // "[image]" line per picture. (The pictures themselves are never saved.)
  function storedContent(text, count) {
    var lines = [];
    var clean = String(text || "").trim();
    if (clean) lines.push(clean);
    for (var i = 0; i < count; i += 1) lines.push(MARKER);
    return lines.join("\n");
  }

  // The inverse, for showing a stored message: { text, count }.
  function splitStored(content) {
    var lines = String(content || "").split("\n");
    var count = 0;
    while (lines.length && lines[lines.length - 1].trim() === MARKER) { lines.pop(); count += 1; }
    return { text: lines.join("\n").trim(), count: count };
  }

  function supportsImages(modeId) {
    return VISION_MODES.indexOf(modeId) !== -1;
  }

  // ---- shrinking a picture ------------------------------------------------------------------

  // deps: { decode(file) -> Promise<{width, height, draw(ctx, w, h), close()}>,
  //         createCanvas(w, h) -> {getContext, toDataURL}, readDataUrl(file) -> Promise<string> }
  // -> { dataUrl, width, height, bytes }
  async function prepareImage(file, deps, maxBytes) {
    var budget = maxBytes || MAX_IMAGE_BYTES;
    var picture = await deps.decode(file); // also proves it really is an image
    try {
      var size = fitSize(picture.width, picture.height, MAX_SIDE);
      if (!size.width) throw new Error("empty-image");
      // already small enough and in a format the server takes: send as it is
      if (isAcceptedType(file.type) && size.width === picture.width && size.height === picture.height && file.size <= budget) {
        var plain = await deps.readDataUrl(file);
        if (dataUrlBytes(plain) <= budget) return { dataUrl: plain, width: size.width, height: size.height, bytes: dataUrlBytes(plain) };
      }
      var width = size.width;
      var height = size.height;
      var quality = 0.85;
      for (var attempt = 0; attempt < 10; attempt += 1) {
        var canvas = deps.createCanvas(width, height);
        var context = canvas.getContext("2d");
        context.fillStyle = "#ffffff"; // transparent PNGs become JPEG: no black background
        context.fillRect(0, 0, width, height);
        picture.draw(context, width, height);
        var url = canvas.toDataURL("image/jpeg", quality);
        var bytes = dataUrlBytes(url);
        if (bytes > 0 && bytes <= budget) return { dataUrl: url, width: width, height: height, bytes: bytes };
        if (quality > 0.55) quality = Math.round((quality - 0.1) * 100) / 100;
        else { width = Math.max(1, Math.round(width * 0.8)); height = Math.max(1, Math.round(height * 0.8)); }
      }
      throw new Error("too-large");
    } finally {
      if (typeof picture.close === "function") picture.close();
    }
  }

  // ---- pictures remembered for this session (Retry, regenerate) ---------------------------------

  var session = new Map();
  function remember(messageId, images) {
    if (!messageId || !images || !images.length) return;
    session.delete(messageId);
    session.set(messageId, images.slice());
    while (session.size > SESSION_LIMIT) session.delete(session.keys().next().value);
  }
  function recall(messageId) { return session.has(messageId) ? session.get(messageId).slice() : []; }
  function forget(messageId) { session.delete(messageId); }

  // ---- click to enlarge ---------------------------------------------------------------------------

  function openLightbox(src, alt, doc) {
    doc = doc || document;
    var previouslyFocused = doc.activeElement;
    var backdrop = doc.createElement("div");
    backdrop.className = "lh-dialog-backdrop lightbox-backdrop";
    var box = doc.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Image preview");
    var img = doc.createElement("img");
    img.className = "lightbox-image";
    img.setAttribute("src", src);
    img.setAttribute("alt", alt || "Attached image");
    var close = doc.createElement("button");
    close.type = "button";
    close.className = "lightbox-close";
    close.setAttribute("aria-label", "Close preview");
    close.textContent = "✕";
    box.appendChild(img);
    box.appendChild(close);
    backdrop.appendChild(box);

    function closeBox() {
      doc.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
    }
    function onKeydown(event) {
      if (event.key === "Escape") { event.preventDefault(); closeBox(); }
      else if (event.key === "Tab") { event.preventDefault(); close.focus(); }
    }
    close.addEventListener("click", closeBox);
    backdrop.addEventListener("click", function (event) { if (event.target === backdrop || event.target === img) closeBox(); });
    doc.addEventListener("keydown", onKeydown, true);
    doc.body.appendChild(backdrop);
    close.focus();
    return { close: closeBox, backdrop: backdrop };
  }

  // ---- the composer's attachments ---------------------------------------------------------------------

  // options: { document, strip, fileInput, attachButton, textarea, dropZone,
  //            deps, notify(message), onChange(), isSupported() -> boolean }
  function createAttachments(options) {
    var doc = options.document || document;
    var items = [];
    var pending = 0;
    var nextId = 1;
    var notify = options.notify || function () {};
    var deps = options.deps;

    function changed() {
      render();
      if (typeof options.onChange === "function") options.onChange();
    }

    function slotsLeft() { return MAX_IMAGES - items.length - pending; }

    function remove(id) {
      items = items.filter(function (item) { return item.id !== id; });
      changed();
    }

    function render() {
      var strip = options.strip;
      strip.textContent = "";
      strip.hidden = items.length === 0 && pending === 0;
      items.forEach(function (item, index) {
        var thumb = doc.createElement("div");
        thumb.className = "attach-thumb";
        var open = doc.createElement("button");
        open.type = "button";
        open.className = "attach-thumb-open";
        open.setAttribute("aria-label", "Enlarge image " + (index + 1));
        var img = doc.createElement("img");
        img.setAttribute("src", item.dataUrl);
        img.setAttribute("alt", "Attached image " + (index + 1));
        open.appendChild(img);
        open.addEventListener("click", function () { openLightbox(item.dataUrl, "Attached image " + (index + 1), doc); });
        var del = doc.createElement("button");
        del.type = "button";
        del.className = "attach-remove";
        del.setAttribute("aria-label", "Remove image " + (index + 1));
        del.textContent = "✕";
        del.addEventListener("click", function () { remove(item.id); if (options.textarea) options.textarea.focus(); });
        thumb.appendChild(open);
        thumb.appendChild(del);
        strip.appendChild(thumb);
      });
      for (var i = 0; i < pending; i += 1) {
        var wait = doc.createElement("div");
        wait.className = "attach-thumb is-pending";
        wait.setAttribute("role", "status");
        wait.textContent = "…";
        strip.appendChild(wait);
      }
      if (options.attachButton) options.attachButton.disabled = !supported() || slotsLeft() <= 0;
    }

    function supported() { return typeof options.isSupported === "function" ? Boolean(options.isSupported()) : true; }

    async function addFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return 0;
      if (!supported()) {
        notify("Pictures work in Free chat and Translate. Switch to one of them to attach an image.");
        return 0;
      }
      var accepted = files.filter(function (file) { return file && isAcceptedType(file.type); });
      if (accepted.length < files.length) notify("Only PNG, JPG and WebP images are supported.");
      if (!accepted.length) return 0;
      var room = slotsLeft();
      if (accepted.length > room) {
        notify(room > 0 ? "You can attach up to " + MAX_IMAGES + " images. Added the first " + room + "." : "You can attach up to " + MAX_IMAGES + " images per message.");
        accepted = accepted.slice(0, Math.max(0, room));
      }
      if (!accepted.length) return 0;
      pending += accepted.length;
      changed();
      var added = 0;
      for (var i = 0; i < accepted.length; i += 1) {
        try {
          var result = await prepareImage(accepted[i], deps, budgetPerImage(items.length + (accepted.length - i)));
          items.push({ id: nextId++, dataUrl: result.dataUrl, bytes: result.bytes });
          added += 1;
        } catch (err) {
          notify(err && err.message === "too-large" ? "That image is too large to attach, even after shrinking it." : "Couldn't read that image.");
        }
        pending -= 1;
        changed();
      }
      rebalance();
      return added;
    }

    // With several pictures each one gets a smaller share of the request: shrink the
    // ones that no longer fit their share.
    async function rebalance() {
      var share = budgetPerImage(items.length);
      var total = items.reduce(function (sum, item) { return sum + item.bytes; }, 0);
      if (total <= TOTAL_BUDGET_BYTES) return;
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].bytes <= share) continue;
        try {
          var blob = await dataUrlToFile(items[i].dataUrl);
          var smaller = await prepareImage(blob, deps, share);
          items[i].dataUrl = smaller.dataUrl;
          items[i].bytes = smaller.bytes;
        } catch (err) { /* keep it; the server limit still holds because every image is under its own cap */ }
      }
      changed();
    }

    function dataUrlToFile(url) {
      if (deps.dataUrlToFile) return deps.dataUrlToFile(url);
      return Promise.reject(new Error("unsupported"));
    }

    // ---- entry points: button, paste, drag and drop ----
    function openPicker() {
      if (!supported()) { notify("Pictures work in Free chat and Translate. Switch to one of them to attach an image."); return; }
      if (slotsLeft() <= 0) { notify("You can attach up to " + MAX_IMAGES + " images per message."); return; }
      options.fileInput.click();
    }

    if (options.attachButton) options.attachButton.addEventListener("click", openPicker);
    options.fileInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(options.fileInput.files || []);
      options.fileInput.value = "";
      addFiles(files);
    });

    function filesFromClipboard(event) {
      var data = event.clipboardData;
      if (!data) return [];
      var files = [];
      var list = data.items ? Array.prototype.slice.call(data.items) : [];
      list.forEach(function (item) {
        if (item.kind === "file" && /^image\//.test(item.type) && typeof item.getAsFile === "function") {
          var file = item.getAsFile();
          if (file) files.push(file);
        }
      });
      return files;
    }

    if (options.textarea) {
      options.textarea.addEventListener("paste", function (event) {
        var files = filesFromClipboard(event);
        if (!files.length) return;
        var text = event.clipboardData.getData ? event.clipboardData.getData("text/plain") : "";
        if (text) return; // copied text (even from an app that also offers a picture of it): paste the text
        event.preventDefault();
        addFiles(files);
      });
    }

    var dragDepth = 0;
    function hasFiles(event) {
      var types = event.dataTransfer && event.dataTransfer.types ? Array.prototype.slice.call(event.dataTransfer.types) : [];
      return types.indexOf("Files") !== -1;
    }
    function setDropState(on) {
      if (options.dropZone && options.dropZone.classList) options.dropZone.classList.toggle("is-drop-target", on);
    }
    // A mode screen (Translate) that handles its own pictures turns the composer's
    // drop handling off; a dropped file must still never navigate the window to it.
    function active() { return typeof options.isActive === "function" ? Boolean(options.isActive()) : true; }
    doc.addEventListener("dragenter", function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!active()) return;
      dragDepth += 1;
      if (supported()) setDropState(true);
    });
    doc.addEventListener("dragover", function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault(); // without this the browser would open the dropped file instead
      if (event.dataTransfer) event.dataTransfer.dropEffect = active() && supported() ? "copy" : "none";
    });
    doc.addEventListener("dragleave", function (event) {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropState(false);
    });
    doc.addEventListener("drop", function (event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDropState(false);
      if (!active() || event.defaultImagePrevented) return;
      addFiles(event.dataTransfer.files);
    });

    render();

    return {
      addFiles: addFiles,
      count: function () { return items.length; },
      isBusy: function () { return pending > 0; },
      getImages: function () { return items.map(function (item) { return item.dataUrl; }); },
      // hands the pictures over for sending and empties the strip
      take: function () {
        var urls = items.map(function (item) { return item.dataUrl; });
        items = [];
        changed();
        return urls;
      },
      clear: function () { if (items.length || pending) { items = []; changed(); } },
      refresh: render,
      openPicker: openPicker
    };
  }

  // ---- the browser's real image tools --------------------------------------------------------------------

  function browserDeps(win) {
    var doc = win.document;
    return {
      decode: async function (file) {
        if (typeof win.createImageBitmap === "function") {
          var bitmap;
          try { bitmap = await win.createImageBitmap(file, { imageOrientation: "from-image" }); } catch (err) { bitmap = await win.createImageBitmap(file); }
          return { width: bitmap.width, height: bitmap.height, draw: function (ctx, w, h) { ctx.drawImage(bitmap, 0, 0, w, h); }, close: function () { if (bitmap.close) bitmap.close(); } };
        }
        var url = win.URL.createObjectURL(file);
        try {
          var img = await new Promise(function (resolve, reject) { var el = new win.Image(); el.onload = function () { resolve(el); }; el.onerror = function () { reject(new Error("decode")); }; el.src = url; });
          return { width: img.naturalWidth, height: img.naturalHeight, draw: function (ctx, w, h) { ctx.drawImage(img, 0, 0, w, h); }, close: function () {} };
        } finally { win.URL.revokeObjectURL(url); }
      },
      createCanvas: function (w, h) { var canvas = doc.createElement("canvas"); canvas.width = w; canvas.height = h; return canvas; },
      readDataUrl: function (file) {
        return new Promise(function (resolve, reject) { var reader = new win.FileReader(); reader.onload = function () { resolve(String(reader.result)); }; reader.onerror = function () { reject(new Error("read")); }; reader.readAsDataURL(file); });
      },
      // decoded by hand: fetch() of a data: URL would be blocked by the page's connect-src policy
      dataUrlToFile: async function (url) {
        var match = /^data:([^;,]+);base64,(.*)$/.exec(url);
        if (!match) throw new Error("bad-data-url");
        var binary = win.atob(match[2]);
        var bytes = new win.Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new win.File([bytes], "image", { type: match[1] });
      }
    };
  }

  return {
    ACCEPTED_TYPES: ACCEPTED_TYPES,
    MAX_IMAGES: MAX_IMAGES,
    MAX_SIDE: MAX_SIDE,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    TOTAL_BUDGET_BYTES: TOTAL_BUDGET_BYTES,
    VISION_MODES: VISION_MODES,
    MARKER: MARKER,
    budgetPerImage: budgetPerImage,
    fitSize: fitSize,
    dataUrlBytes: dataUrlBytes,
    isAcceptedType: isAcceptedType,
    storedContent: storedContent,
    splitStored: splitStored,
    supportsImages: supportsImages,
    prepareImage: prepareImage,
    remember: remember,
    recall: recall,
    forget: forget,
    openLightbox: openLightbox,
    createAttachments: createAttachments,
    browserDeps: browserDeps
  };
});
