#!/usr/bin/env node
// Uploads a client installer and registers it as a release draft (optionally publishing it to beta).
//
//   VEILBIRD_RELEASE_API=https://api.example.com VEILBIRD_RELEASE_TOKEN=... \
//   npm run release:client -- --platform android --version 1.2.0 --build 12 --min-os "Android 8.0" \
//     --file clients/android/app/build/outputs/apk/release/app-release.apk --publish
//
// --file uploads to whatever storage the Controller uses: a presigned URL with VEILBIRD_RELEASE_STORAGE=s3, otherwise
// ordered chunks to its data volume (the default). --url registers an installer already hosted elsewhere
// (or an App Store / TestFlight link with --distribution). The Controller verifies what it records.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: {
  platform: { type: "string" }, arch: { type: "string" }, channel: { type: "string", default: "beta" }, version: { type: "string" },
  build: { type: "string" }, "min-os": { type: "string" }, file: { type: "string" }, url: { type: "string" }, notes: { type: "string", default: "" },
  distribution: { type: "string", default: "direct" }, publish: { type: "boolean", default: false },
} });
// Operators may still export the pre-rename NORTHSTAR_* names.
const env = (name) => process.env[`VEILBIRD_${name}`] ?? process.env[`NORTHSTAR_${name}`];
const api = env("RELEASE_API")?.replace(/\/+$/, ""), token = env("RELEASE_TOKEN");
function fail(message) { console.error(message); process.exit(1); }
// A build number is registered once. Re-running a CI job reuses its run number, and its installers are already
// registered (by the first attempt or a Console import), so that is a success, not a failure.
function alreadyRegistered() {
  console.log(`::notice::${args.platform} ${arch} build ${args.build} is already registered on the Controller (earlier run or Console import); nothing to upload.`);
  process.exit(0);
}
if (!api || !token) fail("Set VEILBIRD_RELEASE_API (Controller origin) and VEILBIRD_RELEASE_TOKEN.");
if (!args.platform || !args.version || !args.build || !args["min-os"] || (!args.file && !args.url)) fail("Required: --platform --version --build --min-os and --file or --url");
const arch = args.arch || (args.platform === "windows" ? "x64" : "universal"), build = Number(args.build);

async function call(pathname, body, { allow = [] } = {}) {
  const response = await fetch(`${api}${pathname}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !allow.includes(data.code)) fail(`${pathname}: HTTP ${response.status} ${data.error || data.code || ""}`);
  return data;
}

/** Local storage: the same ordered chunks the Console sends, each below the default Nginx body limit. */
async function uploadChunks(bytes, fields) {
  const chunk = 8 * 1024 * 1024, upload = randomUUID();
  for (let offset = 0; ; offset += chunk) {
    const final = offset + chunk >= bytes.byteLength;
    const query = new URLSearchParams({ ...fields, build: String(fields.build), upload, offset: String(offset), ...(final ? { final: "1" } : {}) });
    const response = await fetch(`${api}/api/v1/admin/client-releases/files?${query}`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: bytes.subarray(offset, offset + chunk) });
    const data = await response.json().catch(() => ({}));
    if (data.code === "RELEASE_BUILD_EXISTS") alreadyRegistered();
    if (!response.ok) fail(`Upload failed: HTTP ${response.status} ${data.error || data.code || ""}`);
    if (final) return data.storageKey;
  }
}

const release = { platform: args.platform, arch, channel: args.channel, version: args.version, build, minOs: args["min-os"], notes: args.notes, distribution: args.distribution, publish: args.publish };
if (args.file) {
  const bytes = await readFile(args.file), sha256 = createHash("sha256").update(bytes).digest("hex"), size = bytes.byteLength;
  const fields = { platform: args.platform, arch, version: args.version, build, fileName: path.basename(args.file) };
  const upload = await call("/api/v1/admin/client-releases/uploads", fields, { allow: ["RELEASE_STORAGE_NOT_CONFIGURED", "RELEASE_BUILD_EXISTS"] });
  if (upload.code === "RELEASE_BUILD_EXISTS") alreadyRegistered();
  console.log(`Uploading ${fields.fileName} (${(size / 1048576).toFixed(1)} MB)…`);
  if (upload.uploadUrl) {
    const put = await fetch(upload.uploadUrl, { method: "PUT", body: bytes });
    if (!put.ok) fail(`Upload failed: HTTP ${put.status} ${await put.text()}`);
    Object.assign(release, { storageKey: upload.storageKey, url: upload.publicUrl, sha256, sizeBytes: size });
  } else Object.assign(release, { storageKey: await uploadChunks(bytes, fields), sha256, sizeBytes: size });
} else release.url = args.url;

console.log("Registering release; the Controller downloads the installer once to verify it…");
const created = await call("/api/v1/admin/client-releases", release, { allow: ["RELEASE_BUILD_EXISTS"] });
if (created.code === "RELEASE_BUILD_EXISTS") alreadyRegistered();
console.log(`${created.platform} ${created.version} (${created.build}) ${created.channel}: ${created.status}`);
console.log(created.status === "published" ? `Live on ${api}/download/${created.platform}${created.channel === "beta" ? "?channel=beta" : ""}` : "Draft registered. Publish or promote it in Console → 客户端发布.");
