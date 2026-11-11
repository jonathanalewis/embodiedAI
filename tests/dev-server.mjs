// Tiny stand-in for Vercel, used only by the tests: serves public/ and runs api/turn.js.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const handler = (await import(path.join(root, "api/turn.js"))).default;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/turn") return handler(req, res);
    const file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("not found");
    res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(Number(process.env.PORT || 3123));
