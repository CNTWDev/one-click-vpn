import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const app of ["admin-web", "portal-web"]) {
  test(`${app} serves real map/favicon assets and rejects missing assets`, async (t) => {
    execFileSync(process.execPath, ["scripts/check-frontend-assets.mjs", app], { cwd: root });
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const server = spawn(process.execPath, ["frontend-server.mjs"], {
      cwd: root, env: { ...process.env, PORT: String(port), STATIC_DIR: resolve(root, "dist", app), API_UPSTREAM: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit");
        server.kill();
        await exited;
      }
    });
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("Frontend did not start")), 10000);
      server.once("error", (error) => { clearTimeout(timeout); reject(error); });
      server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Frontend exited: ${code}`)); });
      server.stdout.on("data", (chunk) => {
        if (String(chunk).includes("Northstar frontend listening")) { clearTimeout(timeout); done(); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const map = await fetch(`${base}/world-map.webp`);
    assert.equal(map.status, 200);
    assert.equal(map.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await map.arrayBuffer()), readFileSync(resolve(root, app, "public/world-map.webp")));
    const html = await (await fetch(base)).text();
    const iconPath = html.match(/rel="icon"[^>]*href="([^"]+)"/)[1];
    const icon = await fetch(`${base}${iconPath}`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/svg+xml");
    assert.equal(await icon.text(), readFileSync(resolve(root, "public/favicon.svg"), "utf8"));
    for (const missing of ["/missing-map.webp", "/assets/missing.js"]) {
      const response = await fetch(`${base}${missing}`);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /<!doctype html>/i);
    }
    // Keep SPA history routing working for paths that are not assets.
    assert.equal(await (await fetch(`${base}/account`)).text(), html);
  });
}
