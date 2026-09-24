import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const app = process.argv[2];
assert.ok(["portal-web", "admin-web"].includes(app), "Specify portal-web or admin-web");
const output = resolve("dist", app);
const map = readFileSync(resolve(output, "world-map.webp"));
assert.equal(map.toString("ascii", 0, 4), "RIFF", "Map is not a WebP image");
assert.equal(map.toString("ascii", 8, 12), "WEBP", "Map is not a WebP image");
assert.deepEqual(map, readFileSync(resolve(app, "public/world-map.webp")), "Map changed during build");
const html = readFileSync(resolve(output, "index.html"), "utf8");
const icon = html.match(/<link\b[^>]*rel="icon"[^>]*href="([^"]+)"/i)?.[1];
assert.ok(icon?.startsWith("/assets/") && icon.endsWith(".svg"), "Favicon must be bundled with a versioned asset URL");
assert.deepEqual(readFileSync(resolve(output, icon.slice(1))), readFileSync(resolve("public/favicon.svg")), "Missing or incorrect favicon");
console.log(`${app}: map and branded favicon verified`);
