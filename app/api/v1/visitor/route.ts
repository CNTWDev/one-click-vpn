import { NextResponse } from "next/server";
import { placeOf } from "../../../../server/geo";
import { clientAddress } from "../../../../server/rate-limit";
import { zonePlace } from "../../../../shared/geo-places";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** True for loopback, private and link-local addresses: nothing a website out there would see. */
function internal(address: string) {
  const v4 = address.replace(/^::ffff:/, "");
  return address === "local" || address === "::1" || /^(127|10)\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4)
    || /^169\.254\./.test(v4) || /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe80:/i.test(address);
}

/**
 * The public address this request came from: the "visitor file" on the Portal sign-in page and the apps' home show
 * it as the first thing any website can see. With it, where that address is, coarsely (a city, one decimal of a
 * degree), for the globe: from the offline IP database, else from the device's time zone (?zone=Asia/Shanghai),
 * else null. Nothing is stored or logged.
 */
export async function GET(request: Request) {
  const address = clientAddress(request);
  const ip = internal(address) ? null : address;
  const zone = new URL(request.url).searchParams.get("zone")?.slice(0, 64) || "";
  const seen = ip ? await placeOf(ip) : null;
  const byZone = seen ? null : zonePlace(zone);
  const place = seen ? { lat: seen.lat, lon: seen.lon, names: seen.names, source: "address" }
    : byZone ? { lat: Math.round(byZone.lat * 10) / 10, lon: Math.round(byZone.lon * 10) / 10, names: {}, source: "zone" } : null;
  return NextResponse.json({ ip, place }, { headers: { "Cache-Control": "no-store" } });
}
