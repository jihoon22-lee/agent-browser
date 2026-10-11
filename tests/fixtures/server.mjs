import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = join(fileURLToPath(new URL(".", import.meta.url)), "site");
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
let events = [];
let submitCounts = {};
const results = (q) => [1, 2, 3].map((id) => ({ id, title: `${q} 결과 ${id}` }));

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

function handler(req, res) {
  const url = new URL(req.url, "http://x");
  (async () => {
    if (req.method === "POST" && url.pathname === "/__reset") { events = []; submitCounts = {}; return send(res, 200, { ok: true }); }
    if (req.method === "GET" && url.pathname === "/__log") return send(res, 200, { events, submitCounts });
    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJson(req);
      events.push({ type: "search", body, at: Date.now() });
      return send(res, 200, { results: results(body.q ?? "") });
    }
    if (req.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJson(req);
      const n = (submitCounts[body.requestId] ?? 0) + 1;
      submitCounts[body.requestId] = n;
      events.push({ type: "submit", body, at: Date.now() });
      const delay = Number(url.searchParams.get("delay") ?? 2000);
      await new Promise((r) => setTimeout(r, delay));
      return send(res, 200, { ok: true, duplicate: n > 1 });
    }
    if (req.method !== "GET") return send(res, 405, { error: "method" });
    const rel = normalize(decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..")) return send(res, 404, "not found", "text/plain");
    try {
      const data = await readFile(join(siteDir, rel));
      res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      send(res, 404, "not found", "text/plain");
    }
  })().catch((e) => send(res, 500, { error: String(e) }));
}

function listen(port) {
  return new Promise((resolve) => { const s = createServer(handler); s.listen(port, "127.0.0.1", () => resolve(s.address().port)); });
}
const port = await listen(arg("--port", 8790));
const altPort = args.includes("--alt-port") ? await listen(arg("--alt-port", 8791)) : null;
console.log(JSON.stringify({ ready: true, port, altPort }));
