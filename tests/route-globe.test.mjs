import assert from "node:assert/strict";
import test from "node:test";
import { placeFrom } from "../server/geo-lookup.ts";
import { CITY_PLACES, countryPlace, regionPlace, zonePlace } from "../shared/geo-places.ts";

const reader = (answer) => ({ get: () => answer });

test("an address becomes a coarse city, never more precise than a tenth of a degree", () => {
  const found = placeFrom("203.0.113.5", reader({ city: { names: { en: "Shanghai", "zh-CN": "上海", ru: "Шанхай", de: "Schanghai" } }, location: { latitude: 31.2304, longitude: 121.4737 }, country: { iso_code: "CN" } }));
  assert.deepEqual(found, { lat: 31.2, lon: 121.5, country: "CN", names: { en: "Shanghai", zh: "上海", ru: "Шанхай" } });
  assert.equal(placeFrom("203.0.113.5", reader({ city: { names: { en: "X" } } })), null, "no coordinates");
  assert.equal(placeFrom("203.0.113.5", reader({ location: { latitude: 120, longitude: 0 } })), null, "out of range");
  for (const address of ["10.1.2.3", "192.168.0.1", "127.0.0.1", "::1", "local", ""]) assert.equal(placeFrom(address, reader({ location: { latitude: 1, longitude: 1 } })), null, address);
  assert.equal(placeFrom("203.0.113.5", null), null, "no database");
  assert.equal(placeFrom("203.0.113.5", { get: () => { throw new Error("bad"); } }), null, "a broken file answers null");
});

test("every catalog city of the Console has a place, and other regions fall back to their country", async () => {
  const catalog = new URL("../admin-web/src/region-catalog.ts", import.meta.url);
  const source = (await import("node:fs")).readFileSync(catalog, "utf8");
  const presets = [...source.slice(source.indexOf("const presets")).matchAll(/\["[^"]+", "([^"]+)", "[^"]+", "([A-Z]{2})"\]/g)].map((match) => `${match[1]}|${match[2]}`);
  assert.ok(presets.length > 100);
  for (const key of presets) assert.ok(CITY_PLACES[key], `missing ${key}`);
  assert.deepEqual(regionPlace("Tokyo", "jp"), { lat: 35.68, lon: 139.69 });
  assert.deepEqual(regionPlace("My own name", "DE"), countryPlace("DE"));
  assert.equal(regionPlace("Nowhere", "ZZ"), null);
  assert.equal(regionPlace(null, null), null);
});

test("a time zone places a device whose address cannot be placed", () => {
  assert.deepEqual(zonePlace("Asia/Shanghai"), { lat: 31.23, lon: 121.47 });
  assert.equal(zonePlace("Not/AZone"), null);
  assert.equal(zonePlace(""), null);
});
