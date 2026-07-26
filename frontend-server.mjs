import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = process.env.STATIC_DIR || join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const port = Number(process.env.PORT || 3100);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };

createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "ok" })); return; }
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  let file = join(root, relative);
  if (!file.startsWith(normalize(root))) { response.writeHead(403); response.end("Forbidden"); return; }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
  if (!existsSync(file)) { response.writeHead(404); response.end("Not found"); return; }
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
  createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`Northstar frontend listening on ${port}`));
