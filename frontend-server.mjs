import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

const root = process.env.STATIC_DIR || join(fileURLToPath(new URL(".", import.meta.url)), "dist");
const port = Number(process.env.PORT || 3100);
const apiUpstream = process.env.API_UPSTREAM?.trim().replace(/\/+$/, "") || "";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function proxyApi(request, response) {
  if (!apiUpstream) {
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "API upstream is not configured" }));
    return;
  }

  const target = new URL(request.url || "/api", `${apiUpstream}/`);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  headers.host = request.headers.host || target.host;
  headers["x-forwarded-host"] = request.headers.host || target.host;
  headers["x-forwarded-proto"] = request.headers["x-forwarded-proto"] || "http";
  headers["x-forwarded-for"] = [request.headers["x-forwarded-for"], request.socket.remoteAddress].filter(Boolean).join(", ");

  const transport = target.protocol === "https:" ? requestHttps : requestHttp;
  const upstream = transport(target, { method: request.method, headers }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value;
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("API upstream timeout")));
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "API upstream unavailable" }));
  });
  request.pipe(upstream);
}

createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname === "/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ status: "ok" })); return; }
  if (pathname === "/api" || pathname.startsWith("/api/")) { proxyApi(request, response); return; }
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  let file = join(root, relative);
  if (!file.startsWith(normalize(root))) { response.writeHead(403); response.end("Forbidden"); return; }
  if (!existsSync(file) || !statSync(file).isFile()) file = join(root, "index.html");
  if (!existsSync(file)) { response.writeHead(404); response.end("Not found"); return; }
  response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable" });
  createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`Northstar frontend listening on ${port}`));
