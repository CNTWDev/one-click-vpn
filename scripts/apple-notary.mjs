#!/usr/bin/env node
// Apple notarization status, read from the Notary API with the App Store Connect API key: seconds, on any OS
// (no Mac, no waiting). Lists the team's recent submissions; with --name, reports the newest submission of that
// file and, in GitHub Actions, writes status=<state> and id=<submission> to $GITHUB_OUTPUT.
//
//   VEILBIRD_APPLE_API_KEY_PATH=AuthKey.p8 VEILBIRD_APPLE_API_KEY_ID=... VEILBIRD_APPLE_API_ISSUER_ID=... \
//   node scripts/apple-notary.mjs [--name TrackNothing-1.0.1-18-macos.dmg]
import { createPrivateKey, sign } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { name: { type: "string" } } });
function fail(message) { console.error(message); process.exit(1); }
const keyPath = process.env.VEILBIRD_APPLE_API_KEY_PATH, keyId = process.env.VEILBIRD_APPLE_API_KEY_ID, issuer = process.env.VEILBIRD_APPLE_API_ISSUER_ID;
if (!keyPath || !keyId || !issuer) fail("Set VEILBIRD_APPLE_API_KEY_PATH, VEILBIRD_APPLE_API_KEY_ID and VEILBIRD_APPLE_API_ISSUER_ID.");

const b64url = (data) => Buffer.from(data).toString("base64url");
const key = createPrivateKey(await readFile(keyPath, "utf8"));
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }))}.${b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }))}`;
const token = `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))}`;

// Apple's API sometimes drops a connection: a few tries before giving up.
async function api(pathname) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`https://appstoreconnect.apple.com/notary/v2/${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) fail(`Notary API ${pathname}: HTTP ${response.status} ${data.errors?.map((e) => e.detail || e.title).join("; ") || ""}`);
      return data;
    } catch (error) {
      if (attempt >= 5) fail(`Notary API ${pathname}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

const submissions = (await api("submissions")).data
  .map((item) => ({ id: item.id, ...item.attributes }))
  .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate));
console.log("Submitted (UTC)       State        File                                  Submission");
for (const item of submissions.slice(0, 20)) {
  console.log(`${item.createdDate.slice(0, 19).replace("T", " ")}   ${item.status.padEnd(12)} ${item.name.padEnd(37)} ${item.id}`);
}
if (!args.name) process.exit(0);

const found = submissions.find((item) => item.name === args.name);
if (!found) fail(`No notarization submission of ${args.name}.`);
console.log(`\n${args.name}: ${found.status} (${found.id})`);
if (found.status === "Invalid" || found.status === "Rejected") {
  const log = (await api(`submissions/${found.id}/logs`)).data?.attributes?.developerLogUrl;
  if (log) console.log(await (await fetch(log)).text());
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${found.status}\nid=${found.id}\n`);
