// Self-hosted runner for the page and its API (same handlers Vercel runs), for rail.radox.net.
// Node stdlib only. Behind Caddy, which sets X-Real-IP to the client address.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 3100);

const load = (p) => import(`./api/${p}.js`).then((m) => m.default);
// [method-agnostic route, handler module]; :key is a 64-hex shipment key, validated by the handler
const ROUTES = [
  [/^\/api\/shipments\/([^/]+)\/history\/?$/, "shipments/[key]/history"],
  [/^\/api\/shipments\/([^/]+)\/?$/, "shipments/[key]/index"],
  [/^\/api\/sandbox\/shipments\/([^/]+)\/handover\/?$/, "sandbox/shipments/[key]/handover"],
  [/^\/api\/sandbox\/shipments\/([^/]+)\/deliver\/?$/, "sandbox/shipments/[key]/deliver"],
  [/^\/api\/sandbox\/shipments\/?$/, "sandbox/shipments/index"],
  [/^\/api\/access\/?$/, "access"],
];

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Vercel-style helpers on the plain Node response
function wrap(res) {
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); return res; };
  return res;
}

async function serveStatic(path, res) {
  // never serve the API source, server files, dotfiles or dependencies
  if (/(^|\/)(\.|api\/|node_modules\/|server\.mjs$|package(-lock)?\.json$|vercel\.json$|Dockerfile$)/.test(path.slice(1))) return false;
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) return false;
  try {
    let s = await stat(file);
    if (s.isDirectory()) { file = join(file, "index.html"); s = await stat(file); }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=300" });
    res.end(body);
    return true;
  } catch { return false; }
}

createServer(async (req, res) => {
  wrap(res);
  const url = new URL(req.url, "http://local");
  // one trusted client address, so a caller cannot pick its own rate-limit bucket
  const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "unknown");
  req.headers["x-vercel-forwarded-for"] = ip;
  try {
    for (const [re, mod] of ROUTES) {
      const m = url.pathname.match(re);
      if (!m) continue;
      req.query = Object.fromEntries(url.searchParams);
      if (m[1] !== undefined) req.query.key = decodeURIComponent(m[1]);
      if (req.method === "POST") {
        const raw = await readBody(req);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
      }
      return await (await load(mod))(req, res);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (await serveStatic(decodeURIComponent(url.pathname), res)) return;
    }
    res.status(404).json({ error: { code: "E_NOT_FOUND", message: "Nothing here. Open / for the page or /docs for the API." } });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: { code: "E_SERVER", message: "Something failed on our side. Try again in a minute." } });
  }
}).listen(PORT, () => console.log(`rail on :${PORT}`));
