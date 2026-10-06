import test from "node:test";
import assert from "node:assert/strict";
import { importUrls, subscriptionLink } from "../portal-web/src/format.ts";

const link = subscriptionLink("A".repeat(43), { format: "v2ray", mode: "global" }, "https://app.example.com");

test("Hiddify deep link round-trips the subscription URL the way Hiddify parses it", () => {
  // Mirrors hiddify-app LinkParser.deep: a `url` query parameter wins and is decoded.
  const uri = new URL(importUrls.hiddify(link));
  assert.equal(uri.protocol, "hiddify:");
  assert.equal(uri.host, "import");
  assert.equal(uri.searchParams.get("url"), link);
  assert.equal(uri.searchParams.get("name"), "Veilbird");
});

test("Clash deep link round-trips the subscription URL", () => {
  const uri = new URL(importUrls.clash(link));
  assert.equal(uri.host, "install-config");
  assert.equal(uri.searchParams.get("url"), link);
});
