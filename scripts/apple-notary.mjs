#!/usr/bin/env node
// Apple notarization status, read from the Notary API with the App Store Connect API key: seconds, on any OS
// (no Mac, no waiting). Lists the team's recent submissions; with --name, reports the newest submission of that
// file and, in GitHub Actions, writes status=<state> and id=<submission> to $GITHUB_OUTPUT.
//
//   node scripts/apple-notary.mjs [--config apple-notary.json] [--name TrackNothing-1.0.1-18-macos.dmg] [--build 18]
//
// Credentials: a JSON config {"keyPath": "AuthKey.p8", "keyId": "...", "issuerId": "..."} (--config, default
// apple-notary.json next to this script; keyPath is relative to the config file), or the environment variables
// VEILBIRD_APPLE_API_KEY_PATH, VEILBIRD_APPLE_API_KEY_ID, VEILBIRD_APPLE_API_ISSUER_ID (CI). --build N matches the
// DMG of build N whatever its version. --wait M asks again every minute for up to M minutes while Apple is still
// processing it.
import { createPrivateKey, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { config: { type: "string" }, name: { type: "string" }, build: { type: "string" }, wait: { type: "string" } } });
function fail(message) { console.error(message); process.exit(1); }
const configPath = path.resolve(args.config ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "apple-notary.json"));
const config = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : {};
if (args.config && !existsSync(configPath)) fail(`Config ${configPath} not found.`);
const keyPath = config.keyPath ? path.resolve(path.dirname(configPath), config.keyPath.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
  : process.env.VEILBIRD_APPLE_API_KEY_PATH;
const keyId = config.keyId ?? process.env.VEILBIRD_APPLE_API_KEY_ID, issuer = config.issuerId ?? process.env.VEILBIRD_APPLE_API_ISSUER_ID;
if (!keyPath || !keyId || !issuer) fail(`Fill in ${configPath} (keyPath, keyId, issuerId) or set the VEILBIRD_APPLE_API_* variables.`);

const b64url = (data) => Buffer.from(data).toString("base64url");
const key = createPrivateKey(await readFile(keyPath, "utf8"));
function token() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }))}.${b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }))}`;
  return `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))}`;
}

// Apple's API sometimes drops a connection: a few tries before giving up.
async function api(pathname) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`https://appstoreconnect.apple.com/notary/v2/${pathname}`, { headers: { Authorization: `Bearer ${token()}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) fail(`Notary API ${pathname}: HTTP ${response.status} ${data.errors?.map((e) => e.detail || e.title).join("; ") || ""}`);
      return data;
    } catch (error) {
      if (attempt >= 5) fail(`Notary API ${pathname}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

const list = async () => (await api("submissions")).data
  .map((item) => ({ id: item.id, ...item.attributes }))
  .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate));
const submissions = await list();
console.log("Submitted (UTC)       State        File                                  Submission");
for (const item of submissions.slice(0, 20)) {
  console.log(`${item.createdDate.slice(0, 19).replace("T", " ")}   ${item.status.padEnd(12)} ${item.name.padEnd(37)} ${item.id}`);
}
if (!args.name && !args.build) process.exit(0);

const find = (items) => items.find((item) => args.name ? item.name === args.name : item.name.endsWith(`-${args.build}-macos.dmg`));
let found = find(submissions);
if (!found) fail(`No notarization submission of ${args.name ?? `build ${args.build}`}.`);
const deadline = Date.now() + Number(args.wait ?? 0) * 60_000;
while (found.status === "In Progress" && Date.now() + 60_000 <= deadline) {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  found = (await api(`submissions/${found.id}`)).data;
  found = { id: found.id, ...found.attributes };
  console.log(`${new Date().toISOString().slice(11, 19)} ${found.status}`);
}
console.log(`\n${found.name}: ${found.status} (${found.id})`);
if (found.status === "Invalid" || found.status === "Rejected") {
  const log = (await api(`submissions/${found.id}/logs`)).data?.attributes?.developerLogUrl;
  if (log) console.log(await (await fetch(log)).text());
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${found.status}\nid=${found.id}\n`);
