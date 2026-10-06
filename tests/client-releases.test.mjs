import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { latestClientReleases, parseClientReleases } from "../shared/client-releases.ts";

const release = { platform: "android", arch: "universal", channel: "stable", version: "1.0.0", build: 1, status: "published", distribution: "direct", url: "https://downloads.example.com/client.apk", sha256: "a".repeat(64), sizeBytes: 123, minOs: "Android 8", publishedAt: "2026-01-01T00:00:00Z" };
const parse = (...items) => parseClientReleases(JSON.stringify(items));

test("release catalog is empty by default; only public fields are returned", () => {
  assert.deepEqual(latestClientReleases(parse()), []);
  assert.equal(parse({ ...release, signingPassword: "DO_NOT_EXPOSE" })[0].signingPassword, undefined);
});
test("latest is selected by numeric build per OS/architecture; draft, future, beta and withdrawn hidden", () => {
  const items = parse(release, { ...release, build: 10, version: "1.10.0" }, { ...release, build: 11, status: "draft" }, { ...release, build: 12, status: "withdrawn" }, { ...release, build: 13, publishedAt: "2999-01-01" }, { ...release, build: 14, channel: "beta", version: "2.0.0-beta.1" }, { ...release, platform: "windows", arch: "x64" });
  assert.deepEqual(latestClientReleases(items).map((item) => item.build), [10, 1]);
  assert.equal(latestClientReleases(items, "beta")[0].build, 14);
  assert.throws(() => parse(release, release), /Duplicate/);
});
test("unsafe and incomplete download metadata fail closed", () => {
  for (const patch of [{ url: "javascript:alert(1)" }, { url: "http://example.com/a" }, { url: "https://user:pass@example.com/a" }, { sha256: "bad" }, { sizeBytes: -1 }, { platform: "invalid" }, { version: "1.0.0-dev" }, { build: 0 }, { platform: "ios" }]) assert.throws(() => parse({ ...release, ...patch }));
  assert.throws(() => parseClientReleases("{}"));
  assert.throws(() => parseClientReleases(" ".repeat(131073)));
});
test("Apple store URLs must be official and TestFlight cannot masquerade as stable", () => {
  const ios = { ...release, platform: "ios", distribution: "app-store", url: "https://apps.apple.com/app/id123" };
  assert.equal(parse(ios)[0].sha256, undefined);
  assert.throws(() => parse({ ...ios, url: "https://apps.apple.com.evil.example/a" }));
  assert.throws(() => parse({ ...ios, distribution: "testflight", url: "https://testflight.apple.com/join/test" }));
  assert.equal(parse({ ...ios, channel: "beta", distribution: "testflight", url: "https://testflight.apple.com/join/test" })[0].channel, "beta");
});
test("native builds do not publish artifacts or fake a connected tunnel", async () => {
  const apple = await readFile("clients/apple/PacketTunnel/PacketTunnelProvider.swift", "utf8");
  assert.match(apple, /last_handshake_time_sec/);
  const android = await readFile("clients/android/app/src/main/java/com/northstar/client/MainActivity.kt", "utf8");
  assert.match(android, /GoBackend.VpnService.prepare/);
  const windows = await readFile("clients/windows/Northstar/MainWindow.xaml.cs", "utf8");
  assert.match(windows, /Button\(L10n.Text\("connection_unavailable"\),\(\)=>\{\},false\)/);
  const messages = JSON.parse(await readFile("clients/locales/messages.json", "utf8"));
  assert.match(messages.connection_unavailable.en, /unavailable/i);
  const workflow = await readFile(".github/workflows/native-clients.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.doesNotMatch(workflow, /contents: write|gh release|signingPassword/);
});
