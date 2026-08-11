// Static file server for the exported web build + the WebSocket lobby server
// on the same origin. Run: node serve.js  (serves HTTP + WS on PORT).
//
// Compression (brotli, falling back to gzip) happens ASYNCHRONOUSLY in the
// background. Compressing the 39MB Godot wasm synchronously at max quality
// at boot blocked cold starts for 10+ minutes (the health check/HTTP timeout
// kills the instance) - that's what used to keep the site stuck at "Render
// Application loading". Requests are served raw until a file's compressed
// copy is ready, then the compressed bytes are served.

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0"; // Render forwards traffic on this host
const BUILD_DIR = path.join(__dirname, "public");

// Files larger than this use quality-6 brotli: near-best compression but
// thousands of times faster than quality 11 on multi-MB files.
const LARGE_FILE_BYTES = 8 * 1024 * 1024;

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

// urlPath -> { raw, br, gz, etag, compressing }
const cache = {};

function startCompress(entry) {
  if (entry.compressing) return;
  entry.compressing = true;
  const quality = entry.raw.length > LARGE_FILE_BYTES ? 6 : 11;
  zlib.brotliCompress(
    entry.raw,
    { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } },
    (err, br) => {
      if (!err) entry.br = br;
      zlib.gzip(entry.raw, { level: 9 }, (err2, gz) => {
        if (!err2) entry.gz = gz;
        entry.compressing = false;
      });
    }
  );
}

function buildCache() {
  for (const entry of fs.readdirSync(BUILD_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const urlPath = "/" + entry.name;
    const file = path.join(BUILD_DIR, entry.name);
    const raw = fs.readFileSync(file);
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    cache[urlPath] = { raw, br: null, gz: null, etag, compressing: false };
    if (COMPRESS.includes(ext)) startCompress(cache[urlPath]);
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
  // Prefer brotli (smaller, Firefox/Chrome/Safari all accept it since 2021).
  // Serve the compressed copy only once it is ready; while the background
  // compression of this file is still running the request is answered with
  // the raw bytes so nothing ever waits on compression.
  if (entry.br && /\bbr\b/.test(accept)) {
    headers["Content-Encoding"] = "br";
    headers["Content-Length"] = entry.br.length;
    res.writeHead(200, headers);
    res.end(entry.br);
  } else if (entry.gz && /\bgzip\b/.test(accept)) {
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