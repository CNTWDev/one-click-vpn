import { NextResponse } from "next/server";
import { clientAddress } from "../../../../server/rate-limit";

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
 * it as the first thing any website can see. Nothing is stored or logged; null when the address is internal.
 */
export function GET(request: Request) {
  const address = clientAddress(request);
  return NextResponse.json({ ip: internal(address) ? null : address }, { headers: { "Cache-Control": "no-store" } });
}
