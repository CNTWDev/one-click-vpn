import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publicAddress, targetHostname, assertIndependentTarget, selectTarget, targetAddresses, checkTarget } from "../server/reality-target-check.mjs";
import { createTargetServer } from "../deploy/reality-target/server.mjs";

test("REALITY accepts public DNS names only and never reuses app/admin/API", () => {
  assert.equal(targetHostname(" WWW.Example.com "), "www.example.com");
  for (const name of ["localhost", "https://a.example.com", "example.com:443", "x.example.com/path", "x.example.com;id", "127.0.0.1", "a".repeat(64)+".com", null]) assert.throws(() => targetHostname(name));
  assert.throws(() => assertIndependentTarget("app.example.com", { VEILBIRD_PUBLIC_ORIGIN: "https://app.example.com/" }));
  assert.throws(() => assertIndependentTarget("console.example.com", { VEILBIRD_ADMIN_DOMAIN: "console.example.com" }));
  assert.doesNotThrow(() => assertIndependentTarget("www.example.com", { VEILBIRD_PUBLIC_ORIGIN: "https://app.example.com" }));
});

test("private, special-purpose and mixed DNS answers are rejected before TLS", async () => {
  for (const address of ["0.0.0.0", "127.0.0.1", "10.10.0.1", "100.100.100.200", "169.254.169.254", "172.18.1.1", "192.168.1.1", "192.0.2.1", "198.18.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "2001:db8::1", "2002:7f00:1::1", "3fff::1"]) assert.equal(publicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true);
  await assert.rejects(() => targetAddresses("www.example.com", async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }]), /公网/);
  await assert.rejects(() => checkTarget("www.example.com", { resolve: async () => [{ address: "127.0.0.1" }], tlsConnect: () => assert.fail("No private connection allowed") }), /公网/);
});

test("new nodes inherit defaults; existing node targets remain stable", () => {
  assert.equal(selectTarget("", undefined, "default.example.com"), "default.example.com");
  assert.equal(selectTarget("", "old.example.com", "new.example.com"), "old.example.com");
  assert.equal(selectTarget("custom.example.com", "old.example.com", "new.example.com"), "custom.example.com");
  assert.throws(() => selectTarget("", undefined, ""), /默认/);
});

function fakeTls(options, error, alpn = "h2") {
  const socket = new EventEmitter();
  socket.alpnProtocol = alpn;
  socket.getProtocol = () => "TLSv1.3";
  socket.destroy = () => socket.emit("close");
  assert.equal(options.minVersion, "TLSv1.3");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, "www.example.com");
  assert.deepEqual(options.ALPNProtocols, ["h2"]);
  queueMicrotask(() => { if (error) { socket.emit("error", new Error(error)); socket.destroy(); } else socket.emit("secureConnect"); });
  return socket;
}
test("TLS probe pins validated IPs, checks certificate/SNI/ALPN and tries alternate addresses", async () => {
  const called = [];
  const result = await checkTarget("www.example.com", {
    resolve: async () => [{ address: "8.8.8.8" }, { address: "1.1.1.1" }],
    tlsConnect: (options) => { called.push(options.host); return fakeTls(options, options.host === "8.8.8.8" ? "unreachable" : null); },
  });
  assert.deepEqual(called, ["8.8.8.8", "1.1.1.1"]);
  assert.equal(result.address, "1.1.1.1");
  assert.equal(result.alpn, "h2");
  for (const [error, alpn, expected] of [["certificate expired", "h2", /expired/], [null, "http/1.1", /HTTP\/2/]]) {
    await assert.rejects(() => checkTarget("www.example.com", { resolve: async () => [{ address: "1.1.1.1" }], tlsConnect: (options) => fakeTls(options, error, alpn) }), expected);
  }
});

test("static site serves only its public page/health, never API, secrets, or write requests", async () => {
  const server = createTargetServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Northstar/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    for (const pathname of ["/api/health", "/api/subscription?token=test", "/.env", "/server.mjs", "/%2e%2e/.env"]) assert.equal((await fetch(origin+pathname)).status, 404);
    assert.equal(await (await fetch(origin+"/health")).text(), "ok\n");
    assert.equal((await fetch(origin, { method: "POST", body: "test" })).status, 405);
    assert.equal(await (await fetch(origin, { method: "HEAD" })).text(), "");
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("deployment includes isolated target and migration, not privileged controller access", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const target = compose.slice(compose.indexOf("  reality-target:"), compose.indexOf("  db:"));
  assert.match(target, /127\.0\.0\.1:3300:3300/);
  assert.match(target, /read_only: true/);
  assert.match(target, /networks: \[reality-site\]/);
  assert.doesNotMatch(target, /env_file|docker\.sock|privileged/);
  assert.match(await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"), /CREATE TABLE IF NOT EXISTS reality_defaults/);
  const setup = await readFile(new URL("../scripts/setup-reality-target.sh", import.meta.url), "utf8");
  assert.match(setup, /nginx -t && nginx -s reload/);
  assert.match(setup, /proxy_set_header Cookie ""/);
  assert.match(setup, /--deploy-hook/);
  assert.match(setup, /systemctl enable --now northstar-reality-renew.timer/);
});
