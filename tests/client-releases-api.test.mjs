import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

const database = process.env.NORTHSTAR_RELEASE_TEST_DATABASE_URL || process.env.NORTHSTAR_NATIVE_TEST_DATABASE_URL;
const token = "t".repeat(40);

async function withServer(env, port, check) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env: { ...process.env, ...env }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Release API server exited: ${child.exitCode}`);
      if (await fetch(`${base}/api/v1/health`).then((r) => r.ok).catch(() => false)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Built controller must start before testing release API");
    await check(base);
  } finally { child.kill("SIGTERM"); }
}

/** Self-signed HTTPS "CDN" so the Controller can verify artifacts exactly as in production. */
function artifactServer(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "northstar-cdn-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
  const server = createServer({ key: readFileSync(path.join(dir, "key.pem")), cert: readFileSync(path.join(dir, "cert.pem")) }, (request, response) => {
    const body = files[request.url];
    response.writeHead(body ? 200 : 404).end(body || "missing");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, ca: path.join(dir, "cert.pem"), origin: `https://127.0.0.1:${server.address().port}` })));
}

test("client releases: CI drafts, verified artifacts, promotion, permanent links and minimum builds", { skip: !database, timeout: 120000 }, async () => {
  const installer = Buffer.from("northstar-msix-v2"), cdn = await artifactServer({ "/v2.msix": installer, "/v3.msix": Buffer.from("northstar-msix-v3") });
  const admin = { email: `release_${Date.now()}@example.com`, password: "release-admin-password-1" };
  const env = { NORTHSTAR_DATABASE_URL: database, NORTHSTAR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), NORTHSTAR_RELEASE_TOKEN: token,
    NORTHSTAR_ADMIN_EMAIL: admin.email, NORTHSTAR_ADMIN_PASSWORD: admin.password, NORTHSTAR_NATIVE_ACCESS_ENABLED: "1", NODE_EXTRA_CA_CERTS: cdn.ca,
    NORTHSTAR_CLIENT_RELEASES_JSON: "[]" };
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { env: { ...process.env, ...env }, stdio: "pipe" });
  const pool = new pg.Pool({ connectionString: database });
  await pool.query("DELETE FROM client_releases WHERE platform='windows'");
  await pool.query("DELETE FROM client_policies WHERE platform='windows'");
  try {
    await withServer(env, 3395, async (base) => {
      const ci = (pathname, body) => fetch(base + pathname, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const draft = { platform: "windows", arch: "x64", version: "2.0.0", build: 200, minOs: "Windows 10", url: `${cdn.origin}/v2.msix`, channel: "beta" };

      assert.equal((await fetch(`${base}/api/v1/admin/client-releases`, { method: "POST", body: "{}" })).status, 403, "anonymous uploads are refused");
      assert.equal((await ci("/api/v1/admin/client-releases", { ...draft, sha256: "0".repeat(64) })).status, 422, "reported digest must match the served file");
      assert.equal((await ci("/api/v1/admin/client-releases", { ...draft, url: `${cdn.origin}/missing.msix` })).status, 422);
      assert.equal((await ci("/api/v1/admin/client-releases/uploads", { platform: "windows", arch: "x64", version: "2.0.0", build: 200, fileName: "a.msix" })).status, 409, "no storage configured");

      const created = await (await ci("/api/v1/admin/client-releases", { ...draft, publish: true, privateSigningKey: "NEVER_STORE" })).json();
      assert.equal(created.status, "published");
      assert.equal(created.sha256, createHash("sha256").update(installer).digest("hex"));
      assert.equal(created.sizeBytes, installer.length);
      assert.equal((await ci("/api/v1/admin/client-releases", draft)).status, 409, "builds are immutable");
      assert.equal((await ci(`/api/v1/admin/client-releases/${created.id}`, { action: "promote" })).status, 403, "only administrators promote to stable");

      assert.equal((await fetch(`${base}/download/windows`, { redirect: "manual" })).status, 404, "beta builds never reach the stable link");
      assert.equal((await fetch(`${base}/download/windows?channel=beta`, { redirect: "manual" })).headers.get("location"), `${cdn.origin}/v2.msix`);
      const publicText = await (await fetch(`${base}/api/v1/client-releases?channel=beta`)).text();
      assert.doesNotMatch(publicText, /NEVER_STORE|createdBy|storageKey/);

      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(admin) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie").split(";")[0];
      const asAdmin = (pathname, method, body) => fetch(base + pathname, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });

      assert.equal((await asAdmin("/api/v1/admin/client-policy", "PUT", { platform: "windows", minBuild: 200 })).status, 409, "no stable release can satisfy the minimum yet");
      assert.equal((await (await asAdmin(`/api/v1/admin/client-releases/${created.id}`, "POST", { action: "promote" })).json()).channel, "stable");
      assert.equal((await fetch(`${base}/download/windows`, { redirect: "manual" })).headers.get("location"), `${cdn.origin}/v2.msix`);
      assert.equal((await fetch(`${base}/download/windows/x64`, { redirect: "manual" })).status, 302);
      assert.equal((await fetch(`${base}/download/windows/arm64`, { redirect: "manual" })).status, 404, "no ARM64 build published");
      assert.equal((await fetch(`${base}/download/linux`, { redirect: "manual" })).status, 404);

      const check = await (await fetch(`${base}/api/v1/client-releases/latest?platform=windows&build=150`)).json();
      assert.deepEqual([check.latest.build, check.updateAvailable, check.mandatory, check.downloadPath], [200, true, false, "/download/windows/x64"]);

      assert.equal((await asAdmin("/api/v1/admin/client-policy", "PUT", { platform: "windows", minBuild: 200 })).status, 200);
      const nativeLogin = (header) => fetch(`${base}/api/v2/native/login`, { method: "POST", headers: { "Content-Type": "application/json", ...(header ? { "X-Northstar-Client": header } : {}) },
        body: JSON.stringify({ email: "nobody@example.com", password: "x", platform: "windows", identityKey: {} }) });
      for (const header of [undefined, "windows/1.0.0+199", "ios/9.0.0+999"]) {
        const blocked = await nativeLogin(header);
        assert.equal(blocked.status, 426, String(header));
        assert.deepEqual(await blocked.json(), { code: "CLIENT_UPDATE_REQUIRED", minBuild: 200, downloadPath: "/download/windows" });
      }
      assert.equal((await nativeLogin("windows/2.0.0+200")).status, 401, "current builds proceed to the password check");
      assert.equal((await (await fetch(`${base}/api/v1/client-releases/latest?platform=windows`)).json()).mandatory, true);

      assert.equal((await asAdmin(`/api/v1/admin/client-releases/${created.id}`, "POST", { action: "withdraw" })).status, 409, "cannot strand clients below the minimum");
      const next = await (await ci("/api/v1/admin/client-releases", { ...draft, version: "3.0.0", build: 300, url: `${cdn.origin}/v3.msix`, channel: "stable" })).json();
      assert.equal(next.status, "draft");
      assert.equal((await ci(`/api/v1/admin/client-releases/${next.id}`, { action: "publish" })).status, 403, "the release token cannot publish stable");
      assert.equal((await asAdmin(`/api/v1/admin/client-releases/${next.id}`, "POST", { action: "publish" })).status, 200);
      assert.equal((await fetch(`${base}/download/windows`, { redirect: "manual" })).headers.get("location"), `${cdn.origin}/v3.msix`);
      assert.equal((await asAdmin(`/api/v1/admin/client-releases/${next.id}`, "POST", { action: "withdraw" })).status, 200);
      assert.equal((await fetch(`${base}/download/windows`, { redirect: "manual" })).headers.get("location"), `${cdn.origin}/v2.msix`, "withdrawing falls back to the previous build");

      const overview = await (await asAdmin("/api/v1/admin/client-releases", "GET")).json();
      assert.equal(overview.policies.find((p) => p.platform === "windows").minBuild, 200);
      assert.equal(overview.ciTokenConfigured, true);
      assert.equal((await fetch(`${base}/api/v1/admin/client-releases`, { headers: { Authorization: `Bearer ${token}` } })).status, 403, "the release token cannot read the admin overview");
    });

    await withServer({ ...env, NORTHSTAR_CLIENT_RELEASES_JSON: '{"privateSigningKey":"SECRET"}' }, 3396, async (base) => {
      const response = await fetch(`${base}/api/v1/client-releases`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "CLIENT_RELEASES_UNAVAILABLE" }, "invalid legacy manifest fails closed without leaking");
    });
  } finally {
    await pool.query("DELETE FROM client_releases WHERE platform='windows'");
    await pool.query("DELETE FROM client_policies WHERE platform='windows'");
    await pool.end();
    cdn.server.close();
  }
});
