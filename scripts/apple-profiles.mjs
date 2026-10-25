#!/usr/bin/env node
// Installs the provisioning profiles a signed Apple build needs, fetched with the App Store Connect API key, so
// they never have to be downloaded or stored by hand. A missing profile is created for the team's certificate.
//
//   VEILBIRD_APPLE_API_KEY_PATH=AuthKey.p8 VEILBIRD_APPLE_API_KEY_ID=... VEILBIRD_APPLE_API_ISSUER_ID=... \
//   node scripts/apple-profiles.mjs --type MAC_APP_DIRECT --bundle com.veilbird.client.macos=VEILBIRD_MACOS_APP_PROFILE \
//     --bundle com.veilbird.client.macos.tunnel=VEILBIRD_MACOS_TUNNEL_PROFILE
//
// Prints NAME=<profile name> per --bundle (append it to $GITHUB_ENV in CI). The bundle IDs must already be
// registered with their capabilities (clients/RELEASING.md).
import { createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { type: { type: "string" }, bundle: { type: "string", multiple: true, default: [] } } });
function fail(message) { console.error(message); process.exit(1); }
const keyPath = process.env.VEILBIRD_APPLE_API_KEY_PATH, keyId = process.env.VEILBIRD_APPLE_API_KEY_ID, issuer = process.env.VEILBIRD_APPLE_API_ISSUER_ID;
if (!keyPath || !keyId || !issuer) fail("Set VEILBIRD_APPLE_API_KEY_PATH, VEILBIRD_APPLE_API_KEY_ID and VEILBIRD_APPLE_API_ISSUER_ID.");
// Developer ID (direct download) needs a Developer ID Application certificate; App Store / TestFlight a distribution one.
const certificateTypes = { MAC_APP_DIRECT: ["DEVELOPER_ID_APPLICATION", "DEVELOPER_ID_APPLICATION_G2"], IOS_APP_STORE: ["DISTRIBUTION", "IOS_DISTRIBUTION"] };
if (!certificateTypes[args.type] || !args.bundle.length) fail("Required: --type MAC_APP_DIRECT|IOS_APP_STORE and --bundle <identifier>=<NAME> (repeatable)");

const b64url = (data) => Buffer.from(data).toString("base64url");
const key = createPrivateKey(await readFile(keyPath, "utf8"));
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }))}.${b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }))}`;
const token = `${unsigned}.${b64url(sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }))}`;

async function api(pathname, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${pathname}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) fail(`App Store Connect ${pathname.split("?")[0]}: HTTP ${response.status} ${data.errors?.map((e) => e.detail || e.title).join("; ") || ""}`);
  return data;
}

let certificates;
for (const entry of args.bundle) {
  const [identifier, name] = entry.split("=");
  if (!identifier || !name) fail(`Invalid --bundle ${entry}`);
  // The identifier filter also matches longer identifiers: keep the exact one.
  const bundle = (await api(`bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`)).data.find((item) => item.attributes.identifier === identifier);
  if (!bundle) fail(`Bundle ID ${identifier} is not registered: add it in developer.apple.com → Identifiers (clients/RELEASING.md).`);
  let profile = (await api(`bundleIds/${bundle.id}/profiles?limit=200`)).data
    .filter((item) => item.attributes.profileType === args.type && item.attributes.profileState === "ACTIVE")
    .sort((a, b) => Date.parse(b.attributes.expirationDate) - Date.parse(a.attributes.expirationDate))[0];
  if (!profile) {
    certificates ??= (await api("certificates?limit=200")).data.filter((item) => certificateTypes[args.type].includes(item.attributes.certificateType));
    if (!certificates.length) fail(`No ${certificateTypes[args.type][0]} certificate in this team: create one in developer.apple.com → Certificates.`);
    profile = (await api("profiles", { data: { type: "profiles",
      attributes: { name: `TrackNothing ${identifier} ${args.type}`, profileType: args.type },
      relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } }, certificates: { data: certificates.map((item) => ({ type: "certificates", id: item.id })) } } } })).data;
    console.error(`Created profile "${profile.attributes.name}".`);
  }
  // Xcode 16 reads the first folder, earlier versions the second.
  const content = Buffer.from(profile.attributes.profileContent, "base64"), file = `${profile.attributes.uuid}.${args.type.startsWith("MAC") ? "provisionprofile" : "mobileprovision"}`;
  for (const folder of [path.join(os.homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"), path.join(os.homedir(), "Library/MobileDevice/Provisioning Profiles")]) {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, file), content);
  }
  console.log(`${name}=${profile.attributes.name}`);
}
