"use strict";

// Images on a message, server side: validation, provider format, streaming.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const OpenAI = require("openai");
const Images = require("../lib/images.js");
const { buildContext } = require("../lib/contextBuilder.js");
const aiModes = require("../lib/aiModes.js");

function dataUrl(type, bytes) {
  const heads = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 ")])
  };
  const head = heads[type];
  const body = Buffer.concat([head, Buffer.alloc(Math.max(0, (bytes || 100) - head.length), 7)]);
  return "data:image/" + type + ";base64," + body.toString("base64");
}

// ---- validateImages -----------------------------------------------------------------------------------------------------

test("validateImages: accepts up to 4 real PNG, JPEG and WebP data URLs", () => {
  assert.deepEqual(Images.validateImages([]), { ok: true, images: [] });
  const four = [dataUrl("png"), dataUrl("jpeg"), dataUrl("webp"), dataUrl("jpeg", 5000)];
  const result = Images.validateImages(four);
  assert.equal(result.ok, true);
  assert.deepEqual(result.images, four);
});

test("validateImages: a fifth picture, a non-array and non-strings are refused", () => {
  const five = Array.from({ length: 5 }, () => dataUrl("png"));
  assert.equal(Images.validateImages(five).ok, false);
  assert.match(Images.validateImages(five).message, /up to 4/);
  assert.equal(Images.validateImages("data:image/png;base64,AAAA").status, 400);
  assert.equal(Images.validateImages(null).ok, false);
  assert.equal(Images.validateImages([123]).status, 400);
  assert.equal(Images.validateImages([null]).ok, false);
});

test("validateImages: only png/jpeg/webp base64 data URLs - no gif, svg, http URLs, other data, malformed base64", () => {
  const bad = [
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "https://example.com/cat.png",
    "data:text/html;base64,PGgxPmhpPC9oMT4=",
    "data:image/png;base64,",
    "data:image/png;base64,@@@@",
    "data:image/png,rawdata",
    "javascript:alert(1)",
    ""
  ];
  bad.forEach((url) => {
    const result = Images.validateImages([url]);
    assert.equal(result.ok, false, url);
    assert.ok([400, 415].includes(result.status), url);
  });
});

test("validateImages: the bytes must really be that format (a renamed file is refused)", () => {
  const disguised = "data:image/png;base64," + Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
  assert.equal(Images.validateImages([disguised]).status, 415);
  const jpegAsPng = "data:image/png;base64," + dataUrl("jpeg").split(",")[1];
  assert.equal(Images.validateImages([jpegAsPng]).ok, false);
  const webpAsJpeg = "data:image/jpeg;base64," + dataUrl("webp").split(",")[1];
  assert.equal(Images.validateImages([webpAsJpeg]).ok, false);
});

test("validateImages: size limits per image and in total (so the request fits Vercel's 4.5 MB body)", () => {
  assert.equal(Images.validateImages([dataUrl("jpeg", Images.MAX_IMAGE_BYTES)]).ok, true, "exactly the limit is fine");
  const tooBig = Images.validateImages([dataUrl("jpeg", Images.MAX_IMAGE_BYTES + 10)]);
  assert.equal(tooBig.status, 413);
  const nearLimit = Math.floor(Images.MAX_IMAGE_BYTES * 0.9);
  const together = Images.validateImages([dataUrl("png", nearLimit), dataUrl("png", nearLimit), dataUrl("png", nearLimit)]);
  assert.equal(together.status, 413);
  assert.match(together.message, /together/);
  assert.ok(Images.MAX_TOTAL_BYTES * 4 / 3 < 4.5 * 1024 * 1024, "base64 of the total stays under the platform body limit");
});

test("toProviderContent: text first, then each picture; empty text is left out", () => {
  const url = dataUrl("png");
  assert.deepEqual(Images.toProviderContent("what is this?", [url]), [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url, detail: "auto" } }]);
  assert.deepEqual(Images.toProviderContent("   ", [url]).map((p) => p.type), ["image_url"]);
  assert.equal(Images.toProviderContent("", []).length, 0);
});

// ---- context builder ----------------------------------------------------------------------------------------------------

test("buildContext: pictures ride only on the final user message, as provider content parts", () => {
  const url = dataUrl("jpeg");
  const mode = { systemPrompt: "SYS", maxInputChars: 500 };
  const result = buildContext(mode, [
    { role: "user", content: "older", images: [url] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "", images: [url, url] }
  ]);
  const last = result.messages[result.messages.length - 1];
  assert.equal(Array.isArray(last.content), true);
  assert.equal(last.content.filter((p) => p.type === "image_url").length, 2);
  assert.equal(typeof result.messages[1].content, "string", "an older message with pictures is plain text");
  assert.equal(result.messages[1].images, undefined);
  assert.equal(result.messages[0].role, "system");
});

test("buildContext: a picture on an assistant message, or non-data URLs, never reach the provider", () => {
  const mode = { systemPrompt: "SYS", maxInputChars: 500 };
  const result = buildContext(mode, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo", images: [dataUrl("png")] },
    { role: "user", content: "again", images: ["https://evil.example/x.png"] }
  ]);
  assert.ok(result.messages.every((m) => typeof m.content === "string"));
  const empty = buildContext(mode, [{ role: "user", content: "", images: ["https://evil.example/x.png"] }]);
  assert.equal(empty.messages.length, 1, "an empty message with no valid pictures is dropped");
});

test("buildContext: text messages behave exactly as before", () => {
  const mode = { systemPrompt: "SYS", maxInputChars: 5 };
  const result = buildContext(mode, [{ role: "user", content: "123456789" }]);
  assert.equal(result.messages[1].content, "12345");
});

test("modes: only Free chat and Translate can read pictures, and the public list does not expose the flag", () => {
  const withVision = aiModes.MODE_IDS.filter((id) => aiModes.getModeConfig(id).vision === true);
  assert.deepEqual(withVision.sort(), ["general", "translate"]);
  assert.ok(aiModes.ALLOWLISTED_MODELS.includes(aiModes.getModeConfig("general").model));
  aiModes.getPublicModes().forEach((m) => assert.deepEqual(Object.keys(m).sort(), ["capability", "description", "enabled", "id", "label"]));
  assert.match(aiModes.getModeConfig("translate").systemPrompt, /attached picture/);
});

// ---- through the real app -----------------------------------------------------------------------------------------------

async function withServer(fn) {
  delete require.cache[require.resolve("../server.js")];
  const app = require("../server.js");
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { await fn("http://127.0.0.1:" + server.address().port); }
  finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
    delete require.cache[require.resolve("../server.js")];
  }
}

function patchProvider(handler) {
  const original = OpenAI.Chat.Completions.prototype.create;
  OpenAI.Chat.Completions.prototype.create = handler;
  return () => { OpenAI.Chat.Completions.prototype.create = original; };
}

const post = (base, route, body) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("route: a picture with no text in Free chat reaches the provider as content parts, and the reply streams back", async () => {
  const seen = [];
  const restore = patchProvider(async (body) => {
    seen.push(body);
    return (async function* () {
      yield { model: "m", choices: [{ delta: { content: "A cat." } }], usage: null };
    })();
  });
  try {
    await withServer(async (base) => {
      const url = dataUrl("jpeg", 2000);
      const response = await post(base, "/api/chat/stream", { mode: "general", messages: [{ role: "user", content: "", images: [url] }] });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /event-stream/);
      assert.match(await response.text(), /A cat\./);
      assert.equal(seen[0].stream, true);
      assert.equal(seen[0].model, "gpt-4.1-mini");
      const last = seen[0].messages[seen[0].messages.length - 1];
      assert.deepEqual(last.content, [{ type: "image_url", image_url: { url, detail: "auto" } }]);
    });
  } finally { restore(); }
});

test("route: text plus pictures, and the non-streaming route, send text first then the pictures", async () => {
  const seen = [];
  const restore = patchProvider(async (body) => { seen.push(body); return { model: "m", choices: [{ message: { content: "ok" } }], usage: null }; });
  try {
    await withServer(async (base) => {
      const url = dataUrl("png", 3000);
      const response = await post(base, "/api/chat", { mode: "general", messages: [{ role: "user", content: "What does the sign say?", images: [url, url] }] });
      assert.equal((await response.json()).reply, "ok");
      const parts = seen[0].messages[seen[0].messages.length - 1].content;
      assert.deepEqual(parts.map((p) => p.type), ["text", "image_url", "image_url"]);
      assert.equal(parts[0].text, "What does the sign say?");
    });
  } finally { restore(); }
});

test("route: Translate can read a picture (JSON mode is kept)", async () => {
  const seen = [];
  const restore = patchProvider(async (body) => { seen.push(body); return { model: "m", choices: [{ message: { content: "{\"detected\":\"en\",\"translation\":\"Salom\"}" } }], usage: null }; });
  try {
    await withServer(async (base) => {
      const response = await post(base, "/api/chat", { mode: "translate", messages: [{ role: "user", content: "Source language: detect it automatically\nTarget language: Uzbek", images: [dataUrl("webp", 1500)] }] });
      assert.equal(response.status, 200);
      assert.deepEqual(seen[0].response_format, { type: "json_object" });
    });
  } finally { restore(); }
});

test("route: refusals happen before the provider is called - wrong mode, too many, bad type, fake image, wrong message, no content", async () => {
  let providerCalls = 0;
  const restore = patchProvider(async () => { providerCalls += 1; return { model: "m", choices: [{ message: { content: "x" } }], usage: null }; });
  try {
    await withServer(async (base) => {
      const ok = dataUrl("png", 1500);
      const cases = [
        ["grammar can't read images", { mode: "grammar", messages: [{ role: "user", content: "text", images: [ok] }] }, 400, /can't read images/],
        ["five images", { mode: "general", messages: [{ role: "user", content: "x", images: Array.from({ length: 5 }, () => ok) }] }, 400, /up to 4/],
        ["a gif", { mode: "general", messages: [{ role: "user", content: "x", images: ["data:image/gif;base64,R0lGODlh"] }] }, 415, /PNG, JPEG and WebP/],
        ["a renamed html file", { mode: "general", messages: [{ role: "user", content: "x", images: ["data:image/png;base64," + Buffer.from("<script>").toString("base64")] }] }, 415, /not a valid image/],
        ["too large", { mode: "general", messages: [{ role: "user", content: "x", images: [dataUrl("jpeg", Images.MAX_IMAGE_BYTES + 100)] }] }, 413, /too large/],
        ["images on an older message", { mode: "general", messages: [{ role: "user", content: "a", images: [ok] }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, 400, /latest message/],
        ["images on an assistant message", { mode: "general", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", images: [ok] }, { role: "user", content: "c" }] }, 400, /latest message/],
        ["empty text and no pictures", { mode: "general", messages: [{ role: "user", content: "" }] }, 400, /content is required/],
        ["empty text and an empty images list", { mode: "general", messages: [{ role: "user", content: "", images: [] }] }, 400, /content is required/],
        ["images not an array", { mode: "general", messages: [{ role: "user", content: "x", images: "nope" }] }, 400, /Invalid images/]
      ];
      for (const [name, body, status, pattern] of cases) {
        for (const route of ["/api/chat", "/api/chat/stream"]) {
          const response = await post(base, route, body);
          assert.equal(response.status, status, name + " " + route);
          assert.match((await response.json()).reply, pattern, name);
        }
      }
      assert.equal(providerCalls, 0);
    });
  } finally { restore(); }
});

test("route: a body with four compressed pictures fits well under Vercel's 4.5 MB limit", () => {
  const per = Math.floor(Images.MAX_TOTAL_BYTES / 4);
  const body = JSON.stringify({ mode: "general", messages: [{ role: "user", content: "x", images: Array.from({ length: 4 }, () => dataUrl("jpeg", per)) }] });
  assert.ok(Buffer.byteLength(body) < 4.5 * 1024 * 1024, "request is " + Buffer.byteLength(body) + " bytes");
});

test("route: text-only requests are unchanged", async () => {
  const seen = [];
  const restore = patchProvider(async (body) => { seen.push(body); return { model: "m", choices: [{ message: { content: "hi" } }], usage: null }; });
  try {
    await withServer(async (base) => {
      const response = await post(base, "/api/chat", { mode: "general", messages: [{ role: "user", content: "hello" }] });
      assert.equal((await response.json()).reply, "hi");
      assert.equal(seen[0].messages[seen[0].messages.length - 1].content, "hello");
    });
  } finally { restore(); }
});
