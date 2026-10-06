import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function withServer(raw, port, check) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, NORTHSTAR_CLIENT_RELEASES_JSON: raw }, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`Release API server exited: ${child.exitCode}`);
      if (await fetch(`${base}/api/v1/health`).then((r) => r.ok).catch(() => false)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Built controller must start before testing release API");
    await check(base);
  } finally { child.kill("SIGTERM"); }
}

test("release API exposes only approved metadata and rejects unsupported channels", async () => {
  const item = { platform: "android", arch: "universal", channel: "stable", version: "1.0.0", build: 1, status: "published", distribution: "direct", url: "https://downloads.example.com/client.apk", sha256: "a".repeat(64), sizeBytes: 10, minOs: "Android 8", publishedAt: "2026-01-01T00:00:00Z", privateSigningKey: "NEVER_RETURN" };
  await withServer(JSON.stringify([item, { ...item, build: 2, status: "draft" }]), 3395, async (base) => {
    const response = await fetch(`${base}/api/v1/client-releases`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.doesNotMatch(text, /NEVER_RETURN|privateSigningKey/);
    assert.equal(JSON.parse(text).releases.length, 1);
    assert.equal((await fetch(`${base}/api/v1/client-releases?channel=unknown`)).status, 400);
    assert.deepEqual((await (await fetch(`${base}/api/v1/client-releases?channel=beta`)).json()).releases, []);
  });
});

test("invalid operator manifest fails closed without leaking its contents", async () => {
  await withServer('{"privateSigningKey":"SECRET"}', 3396, async (base) => {
    const response = await fetch(`${base}/api/v1/client-releases`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "CLIENT_RELEASES_UNAVAILABLE" });
  });
});
