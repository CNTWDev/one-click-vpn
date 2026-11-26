import { isIP } from "node:net";
import { networkOf, placeOf, readyGeo } from "./geo";

/** At most this many addresses per request: a trace has up to 24 hops. */
const MAX = 32;

export type HopPlace = { ip: string; lat: number; lon: number; country: string; names: { en?: string; zh?: string; ru?: string }; network: string } | { ip: string };

/**
 * Where the routers on the way from an app to its node are: the app traces the path outside the tunnel (core Trace)
 * and asks for the routers' addresses here, to draw them on the route globe. Coarse city places (one decimal) and
 * the network's name from the offline DB-IP files; private and unknown addresses come back with only the address.
 * Router addresses belong to carriers, not to people, but the first ones say which provider the person uses, so
 * nothing here is stored or logged.
 */
export async function routeHopPlaces(body: Record<string, unknown>): Promise<{ hops: HopPlace[] }> {
  const ips = Array.isArray(body.ips) ? body.ips : [];
  const unique = [...new Set(ips.filter((ip): ip is string => typeof ip === "string" && ip.length <= 45 && isIP(ip) !== 0))].slice(0, MAX);
  await readyGeo(1500);
  const hops = await Promise.all(unique.map(async (ip): Promise<HopPlace> => {
    const place = await placeOf(ip);
    return place ? { ip, lat: place.lat, lon: place.lon, country: place.country, names: place.names, network: networkOf(ip) } : { ip };
  }));
  return { hops };
}
