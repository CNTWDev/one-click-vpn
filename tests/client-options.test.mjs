import test from "node:test";
import assert from "node:assert/strict";
import { appOrder, apps, usableCredential } from "../portal-web/src/client-options.ts";

test("one app list for every device, each with its platforms and download page", () => {
  assert.deepEqual(appOrder, ["clashverge", "clashx", "v2rayn", "clashmeta", "v2rayng", "shadowrocket", "stash"]);
  assert.ok(!appOrder.includes("hiddify"));
  for (const app of Object.values(apps)) {
    assert.match(app.url, /^https:\/\//);
    assert.ok(app.platforms.length > 0);
  }
  for (const platform of ["iPhone", "Android", "Mac", "Windows", "Linux"]) assert.ok(Object.values(apps).some((app) => app.platforms.includes(platform)), platform);
});
test("available connection count excludes disabled, expired and blocked credentials", () => {
  const item = { status: "active", userDisabled: false, adminDisabled: false, accountStatus: "active", expiresAt: "2027-01-01T00:00:00Z" };
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(usableCredential(item, now), true);
  for (const override of [{ userDisabled: true }, { adminDisabled: true }, { accountStatus: "suspended" }, { status: "revoked" }, { status: "expired" }, { expiresAt: "2026-01-01T00:00:00Z" }, { expiresAt: "invalid" }]) {
    assert.equal(usableCredential({ ...item, ...override }, now), false);
  }
});
