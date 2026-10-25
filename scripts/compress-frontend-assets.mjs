import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Compresses text assets once at build time, so frontend-server.mjs sends .br/.gz files without
// depending on the host's Nginx configuration and without compressing on every request.
const app = process.argv[2];
if (!["portal-web", "admin-web"].includes(app)) throw new Error("Specify portal-web or admin-web");
const textTypes = new Set([".html", ".js", ".css", ".svg", ".json"]);
let before = 0, after = 0;
for (const entry of readdirSync(resolve("dist", app), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !textTypes.has(extname(entry.name))) continue;
  const file = join(entry.parentPath, entry.name);
  const content = readFileSync(file);
  if (content.length < 1024) continue;
  const brotli = brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: content.length } });
  writeFileSync(`${file}.br`, brotli);
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
  before += content.length; after += brotli.length;
}
console.log(`${app}: ${(before / 1024).toFixed(0)} KB of text assets, ${(after / 1024).toFixed(0)} KB with brotli`);
