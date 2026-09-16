"use strict";

// Phase 7 test-only helper: a minimal static file server for the www/
// directory, standing in for the VS Code "Live Server" dev setup this
// project has been manually tested against since Phase 1 (port 5500,
// no API of its own). Exists only so e2e/verify.js can authentically
// exercise config.js's port-3000-routing logic under the same split-origin
// conditions a real developer uses - never imported by server.js, main.js,
// or anything shipped to a user.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WWW_DIR = path.join(__dirname, "..", "www");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8"
};

function createStaticServer() {
  return http.createServer((req, res) => {
    let requestPath = decodeURIComponent(req.url.split("?")[0]);
    if (requestPath === "/") requestPath = "/index.html";
    const filePath = path.join(WWW_DIR, requestPath);

    // Never serve outside www/ (path traversal guard) - a test helper
    // still shouldn't have an obvious directory-traversal hole.
    if (!filePath.startsWith(WWW_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(data);
    });
  });
}

module.exports = { createStaticServer };

if (require.main === module) {
  const server = createStaticServer();
  server.listen(5500, "127.0.0.1", () => {
    console.log("static server on http://127.0.0.1:5500");
  });
}
