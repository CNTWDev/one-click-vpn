import test from "node:test";
import assert from "node:assert/strict";
import { importUrls, subscriptionLink } from "../portal-web/src/format.ts";

const link = subscriptionLink("A".repeat(43), "https://app.example.com");

test("Hiddify deep link round-trips the subscription URL the way Hiddify parses it", () => {
  // Mirrors hiddify-app LinkParser.deep: a `url` query parameter wins and is decoded.
  const uri = new URL(importUrls.hiddify(link, "TrackNothing"));
  assert.equal(uri.protocol, "hiddify:");
  assert.equal(uri.host, "import");
  assert.equal(uri.searchParams.get("url"), link);
  assert.equal(uri.searchParams.get("name"), "TrackNothing");
});

test("Clash deep link round-trips the subscription URL", () => {
  const uri = new URL(importUrls.clash(link, "TrackNothing"));
  assert.equal(uri.host, "install-config");
  assert.equal(uri.searchParams.get("url"), link);
});

test("One link for every app: no format or routing mode is baked in", () => {
  assert.equal(link, `https://app.example.com/api/subscription?token=${"A".repeat(43)}`);
  const uri = importUrls.shadowrocket(link, "TrackNothing");
  assert.match(uri, /^shadowrocket:\/\/add\/sub:\/\//);
  const encoded = uri.slice("shadowrocket://add/sub://".length).split("?")[0];
  assert.equal(Buffer.from(encoded, "base64url").toString(), link);
});
