import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 3187;
const base = `http://127.0.0.1:${port}`;
let dataDir;
let server;

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
  dataDir = await mkdtemp(path.join(tmpdir(), "northstar-test-"));
  server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NORTHSTAR_DATABASE_PATH: path.join(dataDir, "northstar.sqlite"),
      NORTHSTAR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      NORTHSTAR_ADMIN_EMAIL: "owner@example.com",
      NORTHSTAR_ADMIN_PASSWORD: "test-password-123",
      NORTHSTAR_PUBLIC_ORIGIN: base,
    },
    stdio: "ignore",
  });
  await waitForServer();
});

after(async () => {
  server?.kill("SIGTERM");
  await rm(dataDir, { recursive: true, force: true });
});

test("health endpoint is public", async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json().then((body) => body.status), "ok");
});

test("node API requires an authenticated session", async () => {
  const response = await fetch(`${base}/api/nodes`);
  assert.equal(response.status, 401);
});

test("owner can sign in and read an empty fleet", async () => {
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

test("v1 bearer session can manage a device", async () => {
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

test("v1 agent tasks reject invalid credentials", async () => {
  const response = await fetch(`${base}/api/v1/agent/tasks/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId: "missing", token: "invalid" }),
  });
  assert.equal(response.status, 401);
});
