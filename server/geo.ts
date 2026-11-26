import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Reader, type AsnResponse, type CityResponse, type CountryResponse } from "mmdb-lib";
import { writeOperationalLog } from "./operational-logs";
import { cohortOf as lookup, FILES, geoUrls, placeFrom, type Cohort, type Databases, type SeenPlace } from "./geo-lookup";

export type { Cohort, SeenPlace } from "./geo-lookup";

/**
 * Country and network (ASN) of a client address, from DB-IP's free "Lite" databases (CC BY 4.0, IP Geolocation
 * by DB-IP, https://db-ip.com). Only these two labels are kept; the address itself is never stored. The Controller
 * downloads both files on first use and again when they are over 35 days old (DB-IP publishes monthly), into
 * VEILBIRD_GEO_DIR (default data/geo). VEILBIRD_GEO_DOWNLOAD=off keeps whatever files are there.
 */

const MAX_AGE = 35 * 86400_000;
const RETRY = 6 * 3600_000;

type State = { databases: Databases | null; loadedAt: number; checking: Promise<void> | null; lastTry: number };
const state: State = (globalThis as { __geo?: State }).__geo ??= { databases: null, loadedAt: 0, checking: null, lastTry: 0 };

export function geoDirectory(): string {
  return process.env.VEILBIRD_GEO_DIR?.trim() || join(process.cwd(), "data", "geo");
}

async function download(kind: keyof typeof FILES): Promise<void> {
  let lastError = "";
  for (const url of geoUrls(kind)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) { lastError = `HTTP ${response.status}`; continue; }
      const data = gunzipSync(Buffer.from(await response.arrayBuffer()));
      new Reader(data); // A truncated or wrong file throws here and never replaces a good one.
      const directory = geoDirectory(), target = join(directory, `${FILES[kind]}.mmdb`);
      await mkdir(directory, { recursive: true });
      await writeFile(`${target}.tmp`, data);
      await rename(`${target}.tmp`, target);
      return;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
  }
  throw new Error(`${FILES[kind]}: ${lastError}`);
}

async function age(kind: keyof typeof FILES): Promise<number> {
  try { return Date.now() - (await stat(join(geoDirectory(), `${FILES[kind]}.mmdb`))).mtimeMs; } catch { return Infinity; }
}

async function load(): Promise<void> {
  const read = async (kind: keyof typeof FILES) => readFile(join(geoDirectory(), `${FILES[kind]}.mmdb`));
  state.databases = { country: new Reader<CountryResponse>(await read("country")), asn: new Reader<AsnResponse>(await read("asn")) };
  state.loadedAt = Date.now();
}

/** Loads the files, downloading them first when missing or stale; at most one check at a time, retried after 6 h. */
async function refresh(now = Date.now()): Promise<void> {
  state.lastTry = now;
  if (process.env.VEILBIRD_GEO_DOWNLOAD !== "off") {
    for (const kind of ["country", "asn"] as const) {
      if (await age(kind) < MAX_AGE) continue;
      try { await download(kind); } catch (error) {
        void writeOperationalLog({ component: "controller", level: "warning", action: "geo.download_failed", source: "system", message: `IP location database download failed: ${error instanceof Error ? error.message : error}` });
      }
    }
  }
  try { await load(); } catch { /* No files yet: lookups answer null until a later check succeeds. */ }
}

function due(now: number): boolean {
  if (state.checking) return false;
  if (!state.databases) return now - state.lastTry >= (state.lastTry ? RETRY : 0);
  return now - state.loadedAt >= 24 * 3600_000;
}

/** Starts a background check when one is due; never makes the caller wait. */
export function warmGeo(now = Date.now()): void {
  if (!due(now)) return;
  state.checking = refresh(now).finally(() => { state.checking = null; });
}

/** Like warmGeo, but before the first load waits up to maxWaitMs, so reports right after a restart are not lost. */
export async function readyGeo(maxWaitMs = 2000, now = Date.now()): Promise<void> {
  warmGeo(now);
  if (!state.databases && state.checking) await Promise.race([state.checking, new Promise((resolve) => setTimeout(resolve, maxWaitMs))]);
}

/** Country code and ASN of a public address from the loaded databases, or null. */
export function cohortOf(address: string): Cohort | null {
  return lookup(address, state.databases);
}

/*
 * The city file (about 130 MB in memory) is only for the globe on the apps' home and the Portal: where the device
 * is while not connected. It loads on the first such request, never at start, and VEILBIRD_GEO_CITY=off leaves it
 * out entirely (the apps then place the device by its time zone). Same download and refresh rules as above.
 */
type CityState = { reader: Reader<CityResponse> | null; loadedAt: number; checking: Promise<void> | null; lastTry: number };
const city: CityState = (globalThis as { __geoCity?: CityState }).__geoCity ??= { reader: null, loadedAt: 0, checking: null, lastTry: 0 };

function cityEnabled(): boolean { return process.env.VEILBIRD_GEO_CITY?.trim().toLowerCase() !== "off"; }

async function refreshCity(now = Date.now()): Promise<void> {
  city.lastTry = now;
  if (process.env.VEILBIRD_GEO_DOWNLOAD !== "off" && await age("city") >= MAX_AGE) {
    try { await download("city"); } catch (error) {
      void writeOperationalLog({ component: "controller", level: "warning", action: "geo.download_failed", source: "system", message: `IP city database download failed: ${error instanceof Error ? error.message : error}` });
    }
  }
  try { city.reader = new Reader<CityResponse>(await readFile(join(geoDirectory(), `${FILES.city}.mmdb`))); city.loadedAt = Date.now(); } catch { /* not there yet */ }
}

/** Starts loading (or refreshing) the city file when due; never makes the caller wait. */
export function warmCity(now = Date.now()): void {
  if (!cityEnabled() || city.checking) return;
  const due = city.reader ? now - city.loadedAt >= 24 * 3600_000 : now - city.lastTry >= (city.lastTry ? RETRY : 0);
  if (due) city.checking = refreshCity(now).finally(() => { city.checking = null; });
}

/** The coarse place of a public address, or null; waits up to maxWaitMs for a first load. */
export async function placeOf(address: string, maxWaitMs = 1500): Promise<SeenPlace | null> {
  if (!cityEnabled()) return null;
  warmCity();
  if (!city.reader && city.checking) await Promise.race([city.checking, new Promise((resolve) => setTimeout(resolve, maxWaitMs))]);
  return placeFrom(address, city.reader);
}

/** The network (AS organisation) of a public address, e.g. "China Telecom", or "" when unknown. */
export function networkOf(address: string): string {
  if (!cohortOf(address)) return "";
  try {
    const name = state.databases?.asn.get(address)?.autonomous_system_organization;
    return typeof name === "string" && name.trim() && name.length <= 80 ? name.trim() : "";
  } catch { return ""; }
}
