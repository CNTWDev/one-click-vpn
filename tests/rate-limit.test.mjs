import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { apiRetryAfter, BAN_THRESHOLD, banRemaining, recordAuthFailure } from "../server/rate-limit.ts";

const request = (ip, headers = {}) => new Request("http://127.0.0.1/", { headers: ip ? { "x-real-ip": ip, ...headers } : headers });
const burst = (count, make, path) => Array.from({ length: count }, () => apiRetryAfter(make(), path));

test("requests from this host (no X-Real-IP) are never limited", () => {
  assert.ok(burst(500, () => request(null), "/api/v1/health").every((wait) => wait === 0));
});

test("public endpoints allow a burst of 60 per address, then ask the caller to wait", () => {
  const waits = burst(61, () => request("198.51.100.1"), "/api/v1/availability");
  assert.ok(waits.slice(0, 60).every((wait) => wait === 0));
  assert.ok(waits[60] >= 1);
  assert.equal(apiRetryAfter(request("198.51.100.2"), "/api/v1/availability"), 0, "other addresses are unaffected");
});

test("app status polling is limited per session, not per address", () => {
  const session = (token) => () => request("198.51.100.3", { authorization: `Bearer ${token}` });
  const first = burst(31, session("a".repeat(43)), "/api/v2/native/status/lease");
  assert.equal(first.filter((wait) => wait > 0).length, 1);
  assert.equal(apiRetryAfter(session("b".repeat(43))(), "/api/v2/native/status/lease"), 0);
});

test("installer downloads are limited to 30 an hour per address", () => {
  const waits = burst(31, () => request("198.51.100.4"), "/download/android");
  assert.ok(waits.slice(0, 30).every((wait) => wait === 0));
  assert.ok(waits[30] > 60);
});

test("repeated authentication failures ban the address for an hour", () => {
  const offender = () => request("198.51.100.5");
  let banned = false;
  for (let attempt = 1; attempt <= BAN_THRESHOLD; attempt++) banned = recordAuthFailure(offender(), "wrong-password");
  assert.equal(banned, true);
  assert.ok(banRemaining(offender()) > 3500);
  assert.ok(apiRetryAfter(offender(), "/api/v1/health") > 3500);
  assert.equal(recordAuthFailure(request(null), "wrong-password"), false, "local requests are never banned");
});

test("VEILBIRD_RATE_LIMIT=off disables request limits", () => {
  process.env.VEILBIRD_RATE_LIMIT = "off";
  try { assert.equal(apiRetryAfter(request("198.51.100.5"), "/api/v1/health"), 0); }
  finally { delete process.env.VEILBIRD_RATE_LIMIT; }
});

// The proxy and route handlers are separate bundles: a ban recorded by the login route must stop the
// same address everywhere, before any database work.
test("built controller: login throttling turns into a ban enforced by the proxy", { skip: !existsSync(".next/BUILD_ID"), timeout: 60000 }, async () => {
  const port = 3398, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"],
    { env: { ...process.env, VEILBIRD_DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" }, stdio: "ignore" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      ready = await fetch(`${base}/api/v1/health`).then((r) => r.ok).catch(() => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "built controller must start");
    const login = (ip) => fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": ip },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }) });
    // 30 attempts pass the login window; every later one is throttled and counts as a failure.
    for (let attempt = 0; attempt < 30 + BAN_THRESHOLD; attempt++) await login("203.0.113.9");
    const blocked = await fetch(`${base}/api/v1/health`, { headers: { "X-Real-IP": "203.0.113.9" } });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, "RATE_LIMITED");
    assert.ok(Number(blocked.headers.get("retry-after")) > 3500);
    assert.equal((await fetch(`${base}/api/v1/health`, { headers: { "X-Real-IP": "203.0.113.10" } })).status, 200);
  } finally { child.kill("SIGTERM"); }
});
