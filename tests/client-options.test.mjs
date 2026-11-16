import test from "node:test";
import assert from "node:assert/strict";
import { apps, appsFor, otherPlatforms, platformApps, platforms, usableCredential } from "../portal-web/src/client-options.ts";

test("each platform shows only its own apps; every app is listed somewhere", () => {
  assert.deepEqual(appsFor("ios"), ["shadowrocket", "stash"]);
  assert.deepEqual(appsFor("android"), ["clashmeta", "v2rayng"]);
  assert.deepEqual(appsFor("mac"), ["clashverge", "clashx"]);
  assert.deepEqual(appsFor("windows"), ["clashverge", "v2rayn"]);
  assert.deepEqual(appsFor("linux"), ["clashverge"]);
  assert.deepEqual(new Set(Object.values(platformApps).flat()), new Set(Object.keys(apps)));
  for (const platform of platforms) {
    const others = otherPlatforms(platform);
    assert.equal(others.length, platforms.length - 1);
    assert.ok(others.every((item) => item.platform !== platform));
  }
  for (const app of Object.values(apps)) assert.match(app.url, /^https:\/\//);
});
test("available connection count excludes disabled, expired and blocked credentials", () => {
  const item = { status: "active", userDisabled: false, adminDisabled: false, accountStatus: "active", expiresAt: "2027-01-01T00:00:00Z" };
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(usableCredential(item, now), true);
  for (const override of [{ userDisabled: true }, { adminDisabled: true }, { accountStatus: "suspended" }, { status: "revoked" }, { status: "expired" }, { expiresAt: "2026-01-01T00:00:00Z" }, { expiresAt: "invalid" }]) {
    assert.equal(usableCredential({ ...item, ...override }, now), false);
  }
});
