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
test("beta testers also get newer stable builds; releaseFor prefers the exact architecture", async () => {
  const { releaseFor } = await import("../shared/client-releases.ts");
  const items = parse(release, { ...release, build: 20, version: "2.0.0", channel: "stable" }, { ...release, build: 15, channel: "beta", version: "1.5.0-beta.1" },
    { ...release, platform: "windows", arch: "x64", build: 3 }, { ...release, platform: "windows", arch: "arm64", build: 4 });
  assert.equal(latestClientReleases(items, "beta").find((item) => item.platform === "android").build, 20);
  assert.equal(releaseFor(items, "windows", "arm64").build, 4);
  assert.equal(releaseFor(items, "windows", undefined).build, 3, "Windows defaults to x64");
  assert.equal(releaseFor(items, "android", "arm64").build, 20, "universal package serves every architecture");
  assert.equal(releaseFor(items, "macos", undefined), null);
});
test("client agent header and update decisions", async () => {
  const { parseClientAgent, updateDecision } = await import("../shared/client-releases.ts");
  assert.deepEqual(parseClientAgent("android/0.1.0-dev+1"), { platform: "android", version: "0.1.0-dev", build: 1 });
  for (const bad of [null, "", "android/1.0+1", "linux/1.0.0+1", "ios/1.0.0+0", "ios/1.0.0", "ios/1.0.0+1 extra"]) assert.equal(parseClientAgent(bad), null, String(bad));
  const latest = parse({ ...release, build: 10 })[0];
  assert.deepEqual(updateDecision(latest, 0, 9), { latest, updateAvailable: true, mandatory: false, minBuild: 0 });
  assert.equal(updateDecision(latest, 5, 4).mandatory, true);
  assert.equal(updateDecision(latest, 5, null).mandatory, true, "clients without a version header are below any minimum");
  assert.equal(updateDecision(latest, 5, 10).updateAvailable, false);
});
test("S3 presigning matches the AWS SigV4 reference vector; object keys are immutable and safe", async () => {
  const { presignS3Url, releaseObjectKey, releaseStorage } = await import("../server/release-storage.ts");
  const url = presignS3Url({ method: "GET", endpoint: "https://s3.amazonaws.com", bucket: "examplebucket", key: "test.txt", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z"), virtualHost: true });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.equal(releaseObjectKey({ platform: "android", arch: "universal", version: "1.2.0", build: 12, fileName: "../NORTHSTAR 1.2.apk" }), "clients/android/universal/1.2.0+12/NORTHSTAR-1.2.apk");
  assert.throws(() => releaseObjectKey({ platform: "android", arch: "universal", version: "1.2.0", build: 12, fileName: "run.sh" }));
  assert.deepEqual(releaseStorage({}), { mode: "external" });
  assert.throws(() => releaseStorage({ NORTHSTAR_RELEASE_STORAGE: "s3" }), /ENDPOINT/);
  assert.throws(() => releaseStorage({ NORTHSTAR_RELEASE_STORAGE: "s3", NORTHSTAR_RELEASE_S3_ENDPOINT: "http://minio:9000", NORTHSTAR_RELEASE_S3_BUCKET: "b", NORTHSTAR_RELEASE_S3_ACCESS_KEY_ID: "a", NORTHSTAR_RELEASE_S3_SECRET_ACCESS_KEY: "s", NORTHSTAR_RELEASE_PUBLIC_BASE_URL: "https://d.example.com" }), /HTTPS/);
});
test("artifact inspection records what the URL serves and refuses redirects or empty files", async () => {
  const { inspectArtifact } = await import("../server/release-storage.ts");
  const { createHash } = await import("node:crypto");
  const body = Buffer.from("installer bytes");
  let options;
  const result = await inspectArtifact("https://downloads.example.com/a.apk", async (_url, init) => { options = init; return new Response(body); });
  assert.deepEqual(result, { sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.length });
  assert.equal(options.redirect, "error");
  await assert.rejects(inspectArtifact("https://x", async () => new Response("", { status: 200 })), /empty/);
  await assert.rejects(inspectArtifact("https://x", async () => new Response("no", { status: 404 })), /HTTP 404/);
});
