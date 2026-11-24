import { isIP } from "node:net";
import type { AsnResponse, CityResponse, CountryResponse, Reader } from "mmdb-lib";

/** The lookups of geo.ts without the downloads, so tests can use them on fixture files. */
export type Cohort = { country: string; asn: number };
export type Databases = { country: Reader<CountryResponse>; asn: Reader<AsnResponse> };
export const FILES = { country: "dbip-country-lite", asn: "dbip-asn-lite", city: "dbip-city-lite" } as const;

/** DB-IP names its monthly files by year and month; the current month may not be out yet early on the 1st. */
export function geoUrls(kind: keyof typeof FILES, now = new Date()): string[] {
  const months = [0, 1].map((back) => { const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`; });
  return months.map((month) => `https://download.db-ip.com/free/${FILES[kind]}-${month}.mmdb.gz`);
}

/** Country code and ASN of a public address, or null (private address, no database yet, not listed). */
export function cohortOf(address: string, databases: Databases | null): Cohort | null {
  if (!databases || !isIP(address) || isPrivate(address)) return null;
  try {
    const country = databases.country.get(address)?.country?.iso_code || "";
    const asn = Number(databases.asn.get(address)?.autonomous_system_number) || 0;
    return /^[A-Z]{2}$/.test(country) ? { country, asn: Number.isSafeInteger(asn) && asn > 0 ? asn : 0 } : null;
  } catch { return null; }
}

/** A place on the globe: one decimal (about 10 km) at most, and the city's names where the database has them. */
export type SeenPlace = { lat: number; lon: number; country: string; names: { en?: string; zh?: string; ru?: string } };

const coarse = (value: number) => Math.round(value * 10) / 10;

/** The city of a public address from DB-IP's city file, or null (private address, no file, not listed, no coordinates). */
export function placeFrom(address: string, city: Reader<CityResponse> | null): SeenPlace | null {
  if (!city || !isIP(address) || isPrivate(address)) return null;
  try {
    const found = city.get(address);
    const lat = Number(found?.location?.latitude), lon = Number(found?.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const names = (found?.city?.names || {}) as Record<string, string | undefined>;
    const pick = (value: string | undefined) => typeof value === "string" && value.trim() && value.length <= 80 ? value.trim() : undefined;
    const country = found?.country?.iso_code || "";
    return { lat: coarse(lat), lon: coarse(lon), country: /^[A-Z]{2}$/.test(country) ? country : "", names: { en: pick(names.en), zh: pick(names["zh-CN"]), ru: pick(names.ru) } };
  } catch { return null; }
}

function isPrivate(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("::ffff:127.") || lower.startsWith("::ffff:10.") || lower.startsWith("::ffff:192.168.");
}
