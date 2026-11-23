import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Reader } from "mmdb-lib";
import { cohortOf, geoUrls } from "../server/geo-lookup.ts";
import { parseProbeDetail } from "../server/path-probe.ts";
import { appTransports } from "../server/app-transports.ts";

const fixture = (name) => new Reader(readFileSync(new URL(`fixtures/geo/${name}.mmdb`, import.meta.url)));
const databases = { country: fixture("dbip-country-lite"), asn: fixture("dbip-asn-lite") };

test("addresses become a country and network, never kept", () => {
  assert.deepEqual(cohortOf("203.0.113.5", databases), { country: "CN", asn: 4134 });
  assert.deepEqual(cohortOf("203.0.113.200", databases), { country: "CN", asn: 4837 });
  assert.deepEqual(cohortOf("198.51.100.9", databases), { country: "RU", asn: 12389 });
  assert.deepEqual(cohortOf("2001:db8::1", databases), { country: "CN", asn: 0 }, "a country without a listed network");
  assert.equal(cohortOf("8.8.8.8", databases), null, "not listed");
  for (const address of ["10.1.2.3", "192.168.0.1", "100.64.0.1", "127.0.0.1", "::1", "fd00::1", "local", ""]) assert.equal(cohortOf(address, databases), null, address);
  assert.equal(cohortOf("203.0.113.5", null), null, "no database yet");
});

test("probe details: results, optional delay, unknown transports ignored", () => {
  assert.deepEqual(parseProbeDetail("hysteria2=fail, reality=ok:182,xhttp=ok,bogus=ok,reality-alt=ok:0,wireguard=ok:99999", appTransports), [
    { transport: "hysteria2", ok: false, delayMs: null }, { transport: "reality", ok: true, delayMs: 182 }, { transport: "xhttp", ok: true, delayMs: null },
    { transport: "reality-alt", ok: true, delayMs: null }, { transport: "wireguard", ok: true, delayMs: null }]);
  assert.deepEqual(parseProbeDetail("reality=fail:120", appTransports), [{ transport: "reality", ok: false, delayMs: null }]);
  assert.deepEqual(parseProbeDetail(null, appTransports), []);
});

test("DB-IP monthly file names, with last month as the fallback", () => {
  assert.deepEqual(geoUrls("asn", new Date("2026-01-01T03:00:00Z")), ["https://download.db-ip.com/free/dbip-asn-lite-2026-01.mmdb.gz", "https://download.db-ip.com/free/dbip-asn-lite-2025-12.mmdb.gz"]);
});
