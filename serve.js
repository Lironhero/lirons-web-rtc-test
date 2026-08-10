// Static file server for the exported web build + the WebSocket lobby server
// on the same origin. Run: node serve.js  (serves HTTP + WS on 8080).
//
// Performance: .wasm/.pck/.js/.html are served gzip-compressed (browsers
// decompress transparently) and cached in memory, with ETags for fast
// revalidation on reload.

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0"; // Render forwards traffic on this host
const BUILD_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// Files worth compressing (large or text-based).
const COMPRESS = [".wasm", ".pck", ".js", ".html", ".json", ".svg"];

// Precompress static files into memory at startup.
const cache = {}; // urlPath -> { raw, gz, etag }

function buildCache() {
  for (const entry of fs.readdirSync(BUILD_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const urlPath = "/" + entry.name;
    const file = path.join(BUILD_DIR, entry.name);
    const raw = fs.readFileSync(file);
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    cache[urlPath] = { raw, gz: null, etag };
    if (COMPRESS.includes(ext)) {
      cache[urlPath].gz = zlib.gzipSync(raw, { level: 9 });
    }
  }
}

buildCache();

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const entry = cache[urlPath];
  if (!entry) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  // ETag-based revalidation -> 304 on reloads.
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    res.writeHead(304, { "ETag": entry.etag });
    res.end();
    return;
  }

  const headers = {
    "Content-Type": MIME[path.extname(urlPath)] || "application/octet-stream",
    "ETag": entry.etag,
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };

  const accept = req.headers["accept-encoding"] || "";
  if (entry.gz && /\bgzip\b/.test(accept)) {
    headers["Content-Encoding"] = "gzip";
    headers["Content-Length"] = entry.gz.length;
    res.writeHead(200, headers);
    res.end(entry.gz);
  } else {
    headers["Content-Length"] = entry.raw.length;
    res.writeHead(200, headers);
    res.end(entry.raw);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Static server: http://${HOST}:${PORT}  (public/)`);
});

// Lobby + signaling WebSocket server sharing the same port/origin.
require("./server.js").attach(server);
console.log(`Lobby signaling server on ws://127.0.0.1:${PORT}`);
