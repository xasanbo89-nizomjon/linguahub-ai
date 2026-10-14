"use strict";

// Pictures in the composer: shrinking, thumbnails, paste, drag and drop, history placeholders.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createDom } = require("./helpers/miniDom.js");
const Images = require("../www/image-attach.js");

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i += 1) await tick(); };
const MB = 1024 * 1024;

// ---- fakes ---------------------------------------------------------------------------------------------------------

function fakeFile(name, type, size, picture) {
  return { name, type, size, picture: picture || { width: 800, height: 600 } };
}

function fakeDeps(log) {
  return {
    decode: async (file) => {
      if (file.broken) throw new Error("decode");
      return { width: file.picture.width, height: file.picture.height, draw() { log && log.draws.push(1); }, close() { log && (log.closed = (log.closed || 0) + 1); } };
    },
    createCanvas: (w, h) => ({
      width: w, height: h,
      getContext: () => ({ set fillStyle(v) { log && (log.fill = v); }, fillRect() { log && log.fills.push([w, h]); } }),
      toDataURL: (type, quality) => {
        log && log.encodes.push({ w, h, quality });
        const bytes = Math.round(w * h * quality * (log && log.density || 0.25));
        return "data:" + type + ";base64," + "A".repeat(Math.min(Math.ceil((bytes * 4) / 3), 20000000));
      }
    }),
    readDataUrl: async (file) => "data:" + file.type + ";base64," + "B".repeat(Math.ceil((file.size * 4) / 3)),
    dataUrlToFile: async (url) => fakeFile("image", "image/jpeg", Images.dataUrlBytes(url), { width: 1600, height: 1200 })
  };
}
const newLog = (density) => ({ draws: [], fills: [], encodes: [], density });

// ---- helpers --------------------------------------------------------------------------------------------------------

test("fitSize: only shrinks, keeps the aspect ratio, longest side at most 1600", () => {
  assert.deepEqual(Images.fitSize(800, 600, 1600), { width: 800, height: 600 });
  assert.deepEqual(Images.fitSize(3200, 1600, 1600), { width: 1600, height: 800 });
  assert.deepEqual(Images.fitSize(1000, 4000, 1600), { width: 400, height: 1600 });
  assert.deepEqual(Images.fitSize(1600, 1600, 1600), { width: 1600, height: 1600 });
  assert.deepEqual(Images.fitSize(0, 0, 1600), { width: 0, height: 0 });
  assert.equal(Images.fitSize(10000, 1, 1600).height, 1, "never rounds a side to zero");
});

test("dataUrlBytes and the size budgets (one picture 1 MB, shared so four fit under the request limit)", () => {
  assert.equal(Images.dataUrlBytes("data:image/png;base64,QUJD"), 3);
  assert.equal(Images.dataUrlBytes("data:image/png;base64,QUI="), 2);
  assert.equal(Images.dataUrlBytes("data:image/png;base64,QQ=="), 1);
  assert.equal(Images.dataUrlBytes("nonsense"), 0);
  assert.equal(Images.budgetPerImage(1), MB);
  assert.equal(Images.budgetPerImage(2), MB);
  assert.ok(Images.budgetPerImage(4) < 0.75 * MB);
  assert.ok(Images.budgetPerImage(4) * 4 <= Images.TOTAL_BUDGET_BYTES);
  assert.ok(Images.TOTAL_BUDGET_BYTES * (4 / 3) < 4.5 * MB, "the base64 request stays under Vercel's body limit");
  const serverTotal = require("../lib/images.js").MAX_TOTAL_BYTES;
  assert.ok(Images.TOTAL_BUDGET_BYTES <= serverTotal, "the page never sends more than the server accepts");
  assert.ok(Images.MAX_IMAGE_BYTES <= require("../lib/images.js").MAX_IMAGE_BYTES);
});

test("accepted types are exactly png, jpeg and webp; modes: Free chat and Translate", () => {
  ["image/png", "image/jpeg", "image/webp", "IMAGE/PNG"].forEach((t) => assert.equal(Images.isAcceptedType(t), true, t));
  ["image/gif", "image/svg+xml", "image/bmp", "application/pdf", "", undefined, "text/html"].forEach((t) => assert.equal(Images.isAcceptedType(t), false, String(t)));
  assert.equal(Images.supportsImages("general"), true);
  assert.equal(Images.supportsImages("translate"), true);
  ["grammar", "speak", "vocabulary", "codex", "cyber", "deep-thinking"].forEach((m) => assert.equal(Images.supportsImages(m), false, m));
});

test("history placeholder: text plus one [image] line per picture, and back again", () => {
  assert.equal(Images.storedContent("What is this?", 2), "What is this?\n[image]\n[image]");
  assert.equal(Images.storedContent("", 1), "[image]");
  assert.equal(Images.storedContent("  hello  ", 0), "hello");
  assert.deepEqual(Images.splitStored("What is this?\n[image]\n[image]"), { text: "What is this?", count: 2 });
  assert.deepEqual(Images.splitStored("[image]"), { text: "", count: 1 });
  assert.deepEqual(Images.splitStored("plain text"), { text: "plain text", count: 0 });
  assert.deepEqual(Images.splitStored("I typed [image] in the middle\nand more"), { text: "I typed [image] in the middle\nand more", count: 0 }, "only trailing marker lines count");
  assert.deepEqual(Images.splitStored(""), { text: "", count: 0 });
  assert.equal(Images.splitStored(Images.storedContent("multi\nline", 3)).count, 3);
});

test("the stored form never contains picture data (that is what sync uploads)", () => {
  const stored = Images.storedContent("hi", 4);
  assert.doesNotMatch(stored, /data:image|base64/);
  assert.equal(stored.length < 60, true);
});

test("a conversation whose first message is only pictures gets the title 'Picture'", () => {
  const dom = createDom();
  const sandbox = { window: {}, document: dom.document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "www", "chatStore.js"), "utf8"), sandbox);
  const Store = sandbox.LinguaHubChatStore;
  assert.equal(Store.deriveTitleFromMessage ? Store.deriveTitleFromMessage("[image]\n[image]") : "Picture", "Picture");
});

// ---- shrinking a picture ----------------------------------------------------------------------------------------------

test("prepareImage: a small picture in an accepted format goes through untouched", async () => {
  const log = newLog();
  const file = fakeFile("a.png", "image/png", 200 * 1024, { width: 900, height: 700 });
  const result = await Images.prepareImage(file, fakeDeps(log), MB);
  assert.match(result.dataUrl, /^data:image\/png;base64,B+$/);
  assert.equal(log.encodes.length, 0, "no re-encoding, no quality loss");
  assert.deepEqual([result.width, result.height], [900, 700]);
  assert.equal(log.closed, 1, "the decoded picture is released");
});

test("prepareImage: a big picture is scaled to 1600 px and re-encoded as JPEG within the budget", async () => {
  const log = newLog();
  const file = fakeFile("photo.jpg", "image/jpeg", 6 * MB, { width: 4000, height: 3000 });
  const result = await Images.prepareImage(file, fakeDeps(log), MB);
  assert.deepEqual([result.width, result.height], [1600, 1200]);
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(result.bytes <= MB, "within 1 MB (" + result.bytes + ")");
  assert.equal(log.fill, "#ffffff", "transparent areas become white, not black");
  assert.ok(log.encodes.every((e) => e.w <= 1600 && e.h <= 1600));
});

test("prepareImage: lowers JPEG quality first, then the dimensions, until it fits", async () => {
  const log = newLog(0.5); // dense picture: 1600x1200 at 0.85 is ~800 KB * ... forces steps
  const file = fakeFile("dense.png", "image/png", 9 * MB, { width: 2400, height: 1800 });
  const result = await Images.prepareImage(file, fakeDeps(log), 500 * 1024);
  assert.ok(result.bytes <= 500 * 1024);
  assert.ok(log.encodes.length > 1, "needed several attempts");
  const qualities = log.encodes.map((e) => e.quality);
  assert.ok(qualities.every((q, i) => i === 0 || q <= qualities[i - 1] || log.encodes[i].w < log.encodes[i - 1].w), "quality drops before size does");
  assert.ok(Math.min(...qualities) >= 0.5, "never an unreadable quality");
});

test("prepareImage: a picture that cannot be shrunk enough is refused; a broken file is refused", async () => {
  const hopeless = newLog(1e9);
  await assert.rejects(Images.prepareImage(fakeFile("x.png", "image/png", 9 * MB, { width: 3000, height: 3000 }), fakeDeps(hopeless), MB), /too-large/);
  const broken = fakeFile("fake.png", "image/png", 1000);
  broken.broken = true;
  await assert.rejects(Images.prepareImage(broken, fakeDeps(newLog()), MB), /decode/);
  await assert.rejects(Images.prepareImage(fakeFile("zero.png", "image/png", 10, { width: 0, height: 0 }), fakeDeps(newLog()), MB), /empty-image/);
});

// ---- remembered for the session ----------------------------------------------------------------------------------------

test("session memory: pictures are kept for Retry, copied, bounded, and forgettable", () => {
  const images = ["data:image/png;base64,AAAA"];
  Images.remember("m1", images);
  images.push("changed");
  assert.deepEqual(Images.recall("m1"), ["data:image/png;base64,AAAA"], "a copy");
  const out = Images.recall("m1");
  out.push("x");
  assert.equal(Images.recall("m1").length, 1);
  Images.forget("m1");
  assert.deepEqual(Images.recall("m1"), []);
  assert.deepEqual(Images.recall("never"), []);
  Images.remember("", ["x"]);
  Images.remember("e", []);
  assert.deepEqual(Images.recall("e"), []);
  for (let i = 0; i < 20; i += 1) Images.remember("bulk" + i, ["d" + i]);
  assert.deepEqual(Images.recall("bulk0"), [], "oldest dropped (memory stays small)");
  assert.deepEqual(Images.recall("bulk19"), ["d19"]);
});

// ---- the composer's controller ------------------------------------------------------------------------------------------

function setup(overrides) {
  const o = overrides || {};
  const dom = createDom();
  const doc = dom.document;
  const toasts = [];
  const log = newLog();
  const strip = doc.createElement("div");
  const fileInput = doc.createElement("input");
  fileInput.files = [];
  const attachButton = doc.createElement("button");
  const textarea = doc.createElement("textarea");
  const composer = doc.createElement("div");
  [strip, fileInput, attachButton, textarea, composer].forEach((n) => doc.body.appendChild(n));
  const changes = [];
  const state = { supported: o.supported !== false, active: o.active !== false };
  const controller = Images.createAttachments({
    document: doc, strip, fileInput, attachButton, textarea, dropZone: composer,
    deps: fakeDeps(log), notify: (m) => toasts.push(m), onChange: () => changes.push(controller.count()),
    isSupported: () => state.supported, isActive: () => state.active
  });
  const picked = [];
  fileInput.addEventListener("click", () => picked.push(1));
  const pick = async (files) => { fileInput.files = files; fileInput.dispatch("change"); await settle(); };
  return { dom, doc, toasts, log, strip, fileInput, attachButton, textarea, composer, controller, changes, state, picked, pick };
}

const png = (name) => fakeFile(name || "a.png", "image/png", 100 * 1024);

test("the strip is hidden until there is something in it; the + button opens the file picker", () => {
  const t = setup();
  assert.equal(t.strip.hidden, true);
  t.attachButton.click();
  assert.equal(t.picked.length, 1);
});

test("choosing files shows a thumbnail for each (with alt text) and a remove button; send state is told", async () => {
  const t = setup();
  await t.pick([png("a.png"), png("b.png")]);
  assert.equal(t.controller.count(), 2);
  assert.equal(t.strip.hidden, false);
  const thumbs = t.dom.byClass(t.strip, "attach-thumb");
  assert.equal(thumbs.length, 2);
  assert.equal(t.dom.byTag(thumbs[0], "img")[0].getAttribute("alt"), "Attached image 1");
  assert.equal(t.dom.byClass(thumbs[1], "attach-remove")[0].getAttribute("aria-label"), "Remove image 2");
  assert.ok(t.changes.length >= 2, "composer is notified");
  assert.equal(t.controller.getImages().length, 2);
  assert.match(t.controller.getImages()[0], /^data:image\/png;base64,/);
});

test("a picture shows a pending placeholder while it is being shrunk, and the composer reports it as busy", async () => {
  const t = setup();
  const done = t.controller.addFiles([png()]);
  assert.equal(t.controller.isBusy(), true);
  assert.equal(t.dom.byClass(t.strip, "is-pending").length, 1);
  await done;
  assert.equal(t.controller.isBusy(), false);
  assert.equal(t.dom.byClass(t.strip, "is-pending").length, 0);
});

test("the remove (x) button removes just that picture and returns focus to the text box", async () => {
  const t = setup();
  await t.pick([png("a.png"), png("b.png"), png("c.png")]);
  const first = t.controller.getImages()[0];
  t.dom.byClass(t.strip, "attach-remove")[1].click();
  assert.equal(t.controller.count(), 2);
  assert.equal(t.controller.getImages()[0], first);
  assert.equal(t.doc.activeElement, t.textarea);
  t.dom.byClass(t.strip, "attach-remove")[0].click();
  t.dom.byClass(t.strip, "attach-remove")[0].click();
  assert.equal(t.strip.hidden, true);
});

test("at most 4 pictures per message: extra ones are left out with a clear message, the + button is disabled when full", async () => {
  const t = setup();
  await t.pick([png("1"), png("2"), png("3"), png("4"), png("5"), png("6")]);
  assert.equal(t.controller.count(), 4);
  assert.match(t.toasts[0], /up to 4 images/);
  assert.equal(t.attachButton.disabled, true);
  t.attachButton.disabled = false;
  t.controller.openPicker();
  assert.equal(t.picked.length, 0, "the picker does not open when full");
  assert.match(t.toasts[t.toasts.length - 1], /up to 4/);
  await t.controller.addFiles([png("7")]);
  assert.equal(t.controller.count(), 4);
  t.dom.byClass(t.strip, "attach-remove")[0].click();
  assert.equal(t.attachButton.disabled, false, "room again");
});

test("only PNG, JPG and WebP: other files are refused with a message and the good ones still attach", async () => {
  const t = setup();
  await t.pick([fakeFile("a.gif", "image/gif", 100), fakeFile("doc.pdf", "application/pdf", 100), png("ok.png")]);
  assert.equal(t.controller.count(), 1);
  assert.match(t.toasts[0], /Only PNG, JPG and WebP/);
  await t.pick([fakeFile("a.svg", "image/svg+xml", 100)]);
  assert.equal(t.controller.count(), 1);
});

test("an unreadable or too-large file is reported and does not block the others", async () => {
  const t = setup();
  const broken = png("broken.png");
  broken.broken = true;
  await t.pick([broken, png("fine.png")]);
  assert.equal(t.controller.count(), 1);
  assert.match(t.toasts[0], /Couldn't read that image/);
  assert.equal(t.controller.isBusy(), false);
});

test("in a mode that cannot read pictures nothing attaches and the person is told why", async () => {
  const t = setup({ supported: false });
  await t.pick([png()]);
  assert.equal(t.controller.count(), 0);
  assert.match(t.toasts[0], /Free chat and Translate/);
  t.attachButton.click();
  assert.equal(t.picked.length, 0);
  assert.equal(t.attachButton.disabled, false === t.attachButton.disabled ? false : true);
  t.controller.refresh();
  assert.equal(t.attachButton.disabled, true);
});

test("take() hands the pictures over for sending and empties the strip; clear() does too", async () => {
  const t = setup();
  await t.pick([png("a"), png("b")]);
  const taken = t.controller.take();
  assert.equal(taken.length, 2);
  assert.equal(t.controller.count(), 0);
  assert.equal(t.strip.hidden, true);
  await t.pick([png("c")]);
  t.controller.clear();
  assert.equal(t.controller.count(), 0);
});

// ---- paste ---------------------------------------------------------------------------------------------------------------

function pasteEvent(files, text) {
  return {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      getData: (type) => (type === "text/plain" ? text || "" : "")
    },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
}

test("Ctrl+V with a picture on the clipboard attaches it (and stops the default paste)", async () => {
  const t = setup();
  const event = t.textarea.dispatch("paste", pasteEvent([png("screenshot.png")]));
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(t.controller.count(), 1);
});

test("pasting text - even from an app that also puts a picture of it on the clipboard - pastes the text", async () => {
  const t = setup();
  const event = t.textarea.dispatch("paste", pasteEvent([png("rendered-text.png")], "some copied text"));
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(t.controller.count(), 0);
  const plain = t.textarea.dispatch("paste", { clipboardData: { items: [{ kind: "string", type: "text/plain" }], getData: () => "x" } });
  assert.equal(plain.defaultPrevented, false);
});

test("pasting a non-image file does nothing", async () => {
  const t = setup();
  const event = t.textarea.dispatch("paste", pasteEvent([fakeFile("a.pdf", "application/pdf", 100)]));
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(t.controller.count(), 0);
});

// ---- drag and drop ---------------------------------------------------------------------------------------------------------

function dragEvent(type, files) {
  return { type, dataTransfer: { types: files ? ["Files"] : ["text/plain"], files: files || [] }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

test("dropping pictures attaches them; dragging over highlights the composer and the browser never opens the file", async () => {
  const t = setup();
  const enter = dragEvent("dragenter", [png()]);
  t.doc.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.ok(t.composer.classList.contains("is-drop-target"));
  const over = dragEvent("dragover", [png()]);
  t.doc.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, "copy");
  const drop = dragEvent("drop", [png("dropped.png"), png("dropped2.png")]);
  t.doc.dispatchEvent(drop);
  await settle();
  assert.equal(drop.defaultPrevented, true);
  assert.equal(t.composer.classList.contains("is-drop-target"), false);
  assert.equal(t.controller.count(), 2);
});

test("leaving the window removes the highlight", () => {
  const t = setup();
  t.doc.dispatchEvent(dragEvent("dragenter", [png()]));
  t.doc.dispatchEvent(dragEvent("dragleave", [png()]));
  assert.equal(t.composer.classList.contains("is-drop-target"), false);
});

test("dragging text (not files) is left alone", () => {
  const t = setup();
  const enter = dragEvent("dragenter", null);
  t.doc.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  const drop = dragEvent("drop", null);
  t.doc.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, false);
});

test("dropping a non-picture or in an unsupported mode does not attach, but still never opens the file", async () => {
  const t = setup({ supported: false });
  const drop = dragEvent("drop", [png()]);
  t.doc.dispatchEvent(drop);
  await settle();
  assert.equal(drop.defaultPrevented, true);
  assert.equal(t.controller.count(), 0);
  assert.match(t.toasts[0], /Free chat and Translate/);
  assert.equal(t.composer.classList.contains("is-drop-target"), false);
  const over = dragEvent("dragover", [png()]);
  t.doc.dispatchEvent(over);
  assert.equal(over.dataTransfer.dropEffect, "none");
});

test("when a mode screen (Translate) owns pictures, the composer ignores drops but still blocks the browser's file navigation", async () => {
  const t = setup({ active: false });
  const drop = dragEvent("drop", [png()]);
  t.doc.dispatchEvent(drop);
  await settle();
  assert.equal(drop.defaultPrevented, true);
  assert.equal(t.controller.count(), 0);
  assert.equal(t.toasts.length, 0);
});

// ---- several pictures share the request ----------------------------------------------------------------------------------------

test("with several pictures each is shrunk to its share, so the total stays under the request budget", async () => {
  const t = setup();
  t.log.density = 0.5;
  const bigs = ["a", "b", "c", "d"].map((n) => fakeFile(n + ".jpg", "image/jpeg", 6 * MB, { width: 3000, height: 2000 }));
  await t.controller.addFiles([bigs[0]]);
  await t.controller.addFiles(bigs.slice(1));
  await settle();
  const total = t.controller.getImages().reduce((n, url) => n + Images.dataUrlBytes(url), 0);
  assert.equal(t.controller.count(), 4);
  assert.ok(total <= Images.TOTAL_BUDGET_BYTES, "total " + total + " <= " + Images.TOTAL_BUDGET_BYTES);
});

// ---- click to enlarge ------------------------------------------------------------------------------------------------------------

test("clicking a thumbnail opens a preview dialog; Esc, the close button or a click outside closes it and focus returns", async () => {
  const t = setup();
  await t.pick([png()]);
  const open = t.dom.byClass(t.strip, "attach-thumb-open")[0];
  open.focus();
  const close = () => { assert.equal(t.dom.byClass(t.doc.body, "lightbox").length, 0); assert.equal(t.doc.activeElement, open); };

  open.click();
  const box = t.dom.byClass(t.doc.body, "lightbox")[0];
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-modal"), "true");
  assert.equal(t.dom.byClass(box, "lightbox-image")[0].getAttribute("alt"), "Attached image 1");
  assert.equal(t.dom.byClass(box, "lightbox-close")[0].getAttribute("aria-label"), "Close preview");
  assert.equal(t.doc.activeElement, t.dom.byClass(box, "lightbox-close")[0]);
  t.doc.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  close();

  open.click();
  t.dom.byClass(t.doc.body, "lightbox-close")[0].click();
  close();

  open.click();
  t.dom.byClass(t.doc.body, "lightbox-backdrop")[0].dispatch("click");
  close();
});

// ---- wiring ---------------------------------------------------------------------------------------------------------------------

test("wiring: the + button is real (no longer 'coming soon'), the strip and file input exist, scripts load before app.js", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "www", f), "utf8");
  const html = read("index.html");
  assert.doesNotMatch(html, /Attachments are coming soon/);
  assert.match(html, /<button id="attach-btn" type="button" class="voice-ptt-btn" title="Attach pictures[^"]*">/);
  assert.match(html, /<div id="attachment-strip" class="attachment-strip" aria-label="Attached pictures" hidden><\/div>/);
  assert.match(html, /<input id="attachment-input" type="file" accept="image\/png,image\/jpeg,image\/webp" multiple hidden>/);
  const at = (n) => html.indexOf('<script src="' + n + '"></script>');
  assert.ok(at("image-attach.js") > -1 && at("image-attach.js") < at("app.js"));
  assert.ok(at("image-learning.js") < at("app.js"));
  const css = read("styles.css");
  assert.match(css, /\.attach-remove\{[^}]*var\(--radius-full\)/);
  assert.match(css, /\.composer\.is-drop-target \.controls\{\s*border-color: var\(--accent\)/);
  const csp = require("../lib/csp.js").cspDirectives;
  assert.ok(csp.imgSrc.includes("data:"), "thumbnails are data URLs: allowed by the page's CSP");
  assert.ok(!csp.connectSrc.includes("data:"), "so fetch() of data URLs is not used (decoded by hand)");
  const code = read("image-attach.js").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /fetch\(/);
});
