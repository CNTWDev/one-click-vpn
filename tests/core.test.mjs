import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 3187;
const base = `http://127.0.0.1:${port}`;
let server;
const databaseUrl = process.env.NORTHSTAR_TEST_DATABASE_URL;
const integrationOptions = databaseUrl
  ? {}
  : { skip: "Set NORTHSTAR_TEST_DATABASE_URL to a disposable PostgreSQL database to run integration tests." };
const execFileAsync = promisify(execFile);

test("VPN service lifecycle is represented in schema and Agent tasks", () => {
  const migration = readFileSync(path.join(root, "scripts/migrate.mjs"), "utf8");
  const agent = readFileSync(path.join(root, "agent/agent.py"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS vpn_services/);
  assert.match(migration, /deployment_policy TEXT NOT NULL DEFAULT 'standard'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS policy_rollouts/);
  assert.match(agent, /DisableWireGuard/);
  assert.match(agent, /DisableOpenVpn/);
  assert.match(agent, /add\[add\.index\("-C"\)\] = operation/);
  assert.doesNotMatch(agent, /add\[1\] = operation/);
  assert.match(agent, /agent 2\.4\.1/);
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // Next is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next production server did not start in time");
}

before(async () => {
  if (!databaseUrl) {
    return;
  }
  const testEnv = {
    ...process.env,
    NODE_ENV: "production",
    NORTHSTAR_DATABASE_URL: databaseUrl,
    NORTHSTAR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    NORTHSTAR_ADMIN_EMAIL: "owner@example.com",
    NORTHSTAR_ADMIN_PASSWORD: "test-password-123",
    NORTHSTAR_PUBLIC_ORIGIN: base,
  };
  await execFileAsync(process.execPath, [path.join(root, "scripts/migrate.mjs")], { cwd: root, env: testEnv });
  server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: testEnv,
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  server?.kill("SIGTERM");
});

test("health endpoint is public", integrationOptions, async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json().then((body) => body.status), "ok");
});

test("node API requires an authenticated session", integrationOptions, async () => {
  const response = await fetch(`${base}/api/nodes`);
  assert.equal(response.status, 401);
});

test("owner can sign in and read an empty fleet", integrationOptions, async () => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "owner@example.com");

  const nodes = await fetch(`${base}/api/nodes`, { headers: { Cookie: cookie } });
  assert.equal(nodes.status, 200);
  assert.deepEqual((await nodes.json()).nodes, []);
});

test("v1 bearer session can manage a device", integrationOptions, async () => {
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "test-password-123" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  assert.ok(session.accessToken);
  assert.ok(session.refreshToken);

  const device = await fetch(`${base}/api/v1/devices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      displayName: "Test Mac",
      platform: "macos",
      appVersion: "0.1.0",
      publicKey: "test-public-key",
    }),
  });
  assert.equal(device.status, 201);
  const deviceBody = await device.json();
  assert.equal(deviceBody.device.platform, "macos");

  const devices = await fetch(`${base}/api/v1/devices`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(devices.status, 200);
  assert.equal((await devices.json()).devices.length, 1);

  const me = await fetch(`${base}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "owner@example.com");

  const refresh = await fetch(`${base}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  assert.equal(refresh.status, 200);
  assert.ok((await refresh.json()).accessToken);
});

test("v1 agent tasks reject invalid credentials", integrationOptions, async () => {
  const response = await fetch(`${base}/api/v1/agent/tasks/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: "missing", token: "invalid" }),
  });
  assert.equal(response.status, 401);
});
