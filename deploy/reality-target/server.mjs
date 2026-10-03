import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const page = readFileSync(new URL("./index.html", import.meta.url));
export function createTargetServer() {
  return createServer({ requestTimeout: 10000, headersTimeout: 10000, maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    const pathname = (request.url || "").split("?")[0];
    const status = pathname === "/" || pathname === "/health" ? 200 : 404;
    const body = pathname === "/health" ? Buffer.from("ok\n") : status === 200 ? page : Buffer.from("Not found\n");
    response.writeHead(status, { "Content-Type": pathname === "/" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Content-Length": body.length, "Cache-Control": "public, max-age=60" });
    response.end(request.method === "HEAD" ? undefined : body);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createTargetServer();
  server.listen(3300, "0.0.0.0");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
