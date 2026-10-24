import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import test from "node:test";

test("Sites: deployment domains seed the default site; each hostname gets its own brand", { skip: !process.env.VEILBIRD_TEST_DATABASE_URL }, async () => {
  const databaseUrl = process.env.VEILBIRD_TEST_DATABASE_URL;
  const base = "http://127.0.0.1:3196";
  const env = { ...process.env, NODE_ENV: "production", VEILBIRD_DATABASE_URL: databaseUrl, VEILBIRD_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    VEILBIRD_ADMIN_EMAIL: "owner@example.com", VEILBIRD_ADMIN_PASSWORD: "test-password-123", VEILBIRD_PUBLIC_ORIGIN: "https://app.example.com",
    VEILBIRD_PORTAL_DOMAIN: "app.example.com", VEILBIRD_ADMIN_DOMAIN: "console.example.com", VEILBIRD_API_DOMAIN: "api.example.com" };
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query("DROP TABLE IF EXISTS sites");
  await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], { env });
  await promisify(execFile)(process.execPath, ["scripts/migrate.mjs"], { env }); // idempotent: still one default site
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3196"], { env, stdio: "ignore" });
  const json = { "Content-Type": "application/json" };
  const site = (host) => fetch(`${base}/api/v1/site`, { headers: host ? { "X-Forwarded-Host": host } : {} }).then((r) => r.json());
  try {
    for (let attempt = 0; attempt < 100 && !await fetch(base + "/api/health").then((r) => r.ok).catch(() => false); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sites")).rows[0].n, 1);
    const seeded = await site("app.example.com");
    assert.deepEqual({ id: seeded.id, name: seeded.name, isDefault: seeded.isDefault, apiOrigin: seeded.apiOrigin, consoleOrigin: seeded.consoleOrigin },
      { id: "default", name: "TrackNothing", isDefault: true, apiOrigin: "https://api.example.com", consoleOrigin: "https://console.example.com" });

    const cookie = (await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }) })).headers.get("set-cookie").split(";")[0];
    const admin = { ...json, Cookie: cookie };
    const call = (method, path, body) => fetch(base + path, { method, headers: admin, body: body && JSON.stringify(body) });
    assert.equal((await fetch(`${base}/api/v1/admin/sites`)).status, 403);

    const input = { name: "Northern Lights", portalDomain: "HTTPS://Go.Northern.example/", apiDomain: "sub.northern.example", consoleDomain: "", mailFromName: "Northern" };
    assert.match((await (await call("POST", "/api/v1/admin/sites", { ...input, apiDomain: "api.example.com" })).json()).error, /already used/);
    assert.match((await (await call("POST", "/api/v1/admin/sites", { ...input, logoSvg: '<svg onload="alert(1)"></svg>' })).json()).error, /scripts/);
    assert.match((await (await call("POST", "/api/v1/admin/sites", { ...input, apiDomain: "go.northern.example" })).json()).error, /only once/);
    const created = await call("POST", "/api/v1/admin/sites", { ...input, logoSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>' });
    assert.equal(created.status, 201);
    const northern = (await created.json()).site;
    assert.equal(northern.portalDomain, "go.northern.example");
    assert.equal(northern.isDefault, false);

    // Brand follows the requested hostname; unknown hosts fall back to the default site.
    assert.equal((await site("sub.northern.example")).name, "Northern Lights");
    assert.equal((await site("go.northern.example:443")).apiOrigin, "https://sub.northern.example");
    assert.equal((await site("unknown.example.org")).name, "TrackNothing");

    assert.match((await (await call("DELETE", "/api/v1/admin/sites/default")).json()).error, /default site/);
    assert.equal((await call("PATCH", `/api/v1/admin/sites/${northern.id}`, { default: true })).status, 200);
    assert.equal((await site("unknown.example.org")).name, "Northern Lights");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM sites WHERE is_default")).rows[0].n, 1);
    assert.equal((await call("DELETE", "/api/v1/admin/sites/default")).status, 200);
    assert.equal((await call("PUT", `/api/v1/admin/sites/${northern.id}`, { ...input, name: "Aurora" })).status, 200);
    assert.equal((await site("go.northern.example")).name, "Aurora");
  } finally {
    // Other API tests share this database and expect the built-in site from their own .env origins.
    server.kill(); await pool.query("DELETE FROM sites"); await pool.end();
  }
});
