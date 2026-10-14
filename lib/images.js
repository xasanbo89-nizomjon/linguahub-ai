"use strict";

// LinguaHub AI - images attached to a chat message.
//
// The page shrinks every picture before sending (max 1600 px, JPEG, about
// 1 MB; see www/image-attach.js) and sends it as a data URL inside the
// request, on the LAST user message only. This file is the server's check of
// exactly that, before anything reaches the AI provider:
//   - at most MAX_IMAGES pictures per message,
//   - each one a base64 data URL of type png / jpeg / webp whose first bytes
//     really are that format (a renamed file or other data is refused),
//   - each at most MAX_IMAGE_BYTES decoded, and MAX_TOTAL_BYTES together,
//     which keeps the whole request under Vercel's 4.5 MB body limit.
// Pictures are used for the one reply and never stored: not on disk, not in
// logs (callers must not log them), not in Firestore.

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = Math.round(1.5 * 1024 * 1024);
const MAX_TOTAL_BYTES = Math.round(3.0 * 1024 * 1024);

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function decodedBytes(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Do the first bytes match the declared type?
function signatureMatches(type, base64) {
  const head = Buffer.from(base64.slice(0, 24), "base64");
  if (type === "png") return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (type === "jpeg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (type === "webp") return head.length >= 12 && head.slice(0, 4).toString("latin1") === "RIFF" && head.slice(8, 12).toString("latin1") === "WEBP";
  return false;
}

// -> { ok: true, images: string[] } | { ok: false, status, message }
function validateImages(images) {
  if (!Array.isArray(images)) return { ok: false, status: 400, message: "❌ Invalid images." };
  if (images.length === 0) return { ok: true, images: [] };
  if (images.length > MAX_IMAGES) return { ok: false, status: 400, message: "❌ You can attach up to " + MAX_IMAGES + " images." };
  let total = 0;
  for (const image of images) {
    if (typeof image !== "string") return { ok: false, status: 400, message: "❌ Invalid image." };
    const match = DATA_URL.exec(image);
    if (!match) return { ok: false, status: 415, message: "❌ Only PNG, JPEG and WebP images are supported." };
    const bytes = decodedBytes(match[2]);
    if (bytes > MAX_IMAGE_BYTES) return { ok: false, status: 413, message: "❌ An image is too large. Try a smaller one." };
    total += bytes;
    if (total > MAX_TOTAL_BYTES) return { ok: false, status: 413, message: "❌ The images are too large together. Attach fewer or smaller ones." };
    if (!signatureMatches(match[1], match[2])) return { ok: false, status: 415, message: "❌ That file is not a valid image." };
  }
  return { ok: true, images: images.slice() };
}

// The provider's multi-part message content for one user message: its text
// (if any) followed by the pictures.
function toProviderContent(text, images) {
  const parts = [];
  if (typeof text === "string" && text.trim()) parts.push({ type: "text", text });
  images.forEach((url) => parts.push({ type: "image_url", image_url: { url, detail: "auto" } }));
  return parts;
}

module.exports = { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, validateImages, toProviderContent, decodedBytes };
