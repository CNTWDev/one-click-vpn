import test from "node:test";
import assert from "node:assert/strict";
import { clientFormat, clientProtocol, clientOptions, usableCredential } from "../portal-web/src/client-options.ts";

test("client choice separates user-facing app from server protocol and download format", () => {
  assert.equal(clientOptions.length, 3);
  assert.equal(clientProtocol("clash"), "wireguard");
  assert.equal(clientFormat("clash"), "mihomo");
  assert.equal(clientProtocol("wireguard"), "wireguard");
  assert.equal(clientFormat("wireguard"), "native");
  assert.equal(clientProtocol("openvpn"), "openvpn");
  assert.equal(clientFormat("openvpn"), "native");
});
test("available connection count excludes disabled, expired and blocked credentials", () => {
  const item = { status: "active", userDisabled: false, adminDisabled: false, accountStatus: "active", expiresAt: "2027-01-01T00:00:00Z" };
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(usableCredential(item, now), true);
  for (const override of [{ userDisabled: true }, { adminDisabled: true }, { accountStatus: "suspended" }, { status: "revoked" }, { status: "expired" }, { expiresAt: "2026-01-01T00:00:00Z" }, { expiresAt: "invalid" }]) {
    assert.equal(usableCredential({ ...item, ...override }, now), false);
  }
});
