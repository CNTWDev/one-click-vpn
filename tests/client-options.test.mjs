import test from "node:test";
import assert from "node:assert/strict";
import { apps, appsFor, runsOn, usableCredential } from "../portal-web/src/client-options.ts";

test("apps are ordered for the visitor's device and only marked where they run", () => {
  assert.deepEqual(appsFor("ios"), ["shadowrocket", "hiddify", "clash", "v2rayng"]);
  assert.deepEqual(appsFor("android"), ["hiddify", "v2rayng", "clash", "shadowrocket"]);
  assert.deepEqual(appsFor("windows").slice(0, 2), ["clash", "hiddify"]);
  for (const platform of ["ios", "android", "mac", "windows", "linux"]) {
    assert.equal(appsFor(platform).length, Object.keys(apps).length);
    assert.ok(runsOn(appsFor(platform).find((id) => runsOn(id, platform)), platform));
  }
  assert.equal(runsOn("shadowrocket", "android"), false);
  assert.equal(runsOn("v2rayng", "ios"), false);
  assert.equal(runsOn("clash", "mac"), true);
});
test("available connection count excludes disabled, expired and blocked credentials", () => {
  const item = { status: "active", userDisabled: false, adminDisabled: false, accountStatus: "active", expiresAt: "2027-01-01T00:00:00Z" };
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(usableCredential(item, now), true);
  for (const override of [{ userDisabled: true }, { adminDisabled: true }, { accountStatus: "suspended" }, { status: "revoked" }, { status: "expired" }, { expiresAt: "2026-01-01T00:00:00Z" }, { expiresAt: "invalid" }]) {
    assert.equal(usableCredential({ ...item, ...override }, now), false);
  }
});
