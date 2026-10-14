"use strict";

// Generates every app icon from the one source logo, www/logo.svg:
//   assets/icon.ico            Windows (16-256, PNG-compressed frames)
//   assets/icon.icns           macOS (PNG-based icns)
//   assets/icon.png            512x512 (Linux / the Electron window)
//   assets/icons/<size>.png    16 24 32 48 64 128 256 512 1024
//   www/icon-32.png, www/icon-192.png, www/apple-touch-icon.png   web favicon set
//
// Rendering uses the Chromium that ships with the dev dependency
// "playwright" (so no image library is needed); the .ico and .icns
// containers are written by hand below.
//
//   node scripts/build-icons.js

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const svgPath = path.join(root, "www", "logo.svg");
const buildDir = path.join(root, "assets"); // not "build/": that folder is git-ignored
const iconsDir = path.join(buildDir, "icons");

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];

// ICONDIR + ICONDIRENTRY[] + the PNG files, as the Windows .ico format allows.
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + frames.length * 16;
  frames.forEach(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  });
  return Buffer.concat([header].concat(entries, frames.map((f) => f.data)));
}

// 'icns' + total length + (type + length + PNG)[] - all big-endian.
function buildIcns(frames) {
  const parts = frames.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

async function render(svg, sizes) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  const out = {};
  try {
    for (const size of sizes) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      const markup = svg.replace(/<svg /, '<svg style="display:block;width:' + size + "px;height:" + size + 'px" ');
      await page.setContent('<!doctype html><html><body style="margin:0;background:transparent">' + markup + "</body></html>");
      out[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

async function main() {
  const svg = fs.readFileSync(svgPath, "utf8");
  const pngs = await render(svg, PNG_SIZES);
  fs.mkdirSync(iconsDir, { recursive: true });
  PNG_SIZES.forEach((size) => fs.writeFileSync(path.join(iconsDir, size + ".png"), pngs[size]));
  fs.writeFileSync(path.join(buildDir, "icon.png"), pngs[512]);
  fs.writeFileSync(path.join(buildDir, "icon.ico"), buildIco(ICO_SIZES.map((size) => ({ size, data: pngs[size] }))));
  fs.writeFileSync(path.join(buildDir, "icon.icns"), buildIcns(ICNS_TYPES.map(([type, size]) => ({ type, data: pngs[size] }))));

  const web = await render(svg, [180, 192]);
  fs.writeFileSync(path.join(root, "www", "icon-32.png"), pngs[32]);
  fs.writeFileSync(path.join(root, "www", "icon-192.png"), web[192]);
  fs.writeFileSync(path.join(root, "www", "apple-touch-icon.png"), web[180]);
  console.log("icons written to assets/ and www/");
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { buildIco, buildIcns, PNG_SIZES, ICO_SIZES, ICNS_TYPES };
