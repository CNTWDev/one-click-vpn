import { NextResponse } from "next/server";
import { jsonError, readJson } from "../../../../../../server/http";
import { NativeError } from "../../../../../../server/native-proof";
import { portalSessionCookie } from "../../../../../../server/auth";
import { pollQrLogin } from "../../../../../../server/qr-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Portal's login page waits for the phone: once approved, the answer carries the Portal session cookie. */
export async function POST(request: Request) {
  try {
    const result = await pollQrLogin("portal", await readJson(request));
    const response = NextResponse.json({ status: result.status }, { headers: { "Cache-Control": "no-store" } });
    if ("portalSession" in result && result.portalSession) response.headers.set("Set-Cookie", portalSessionCookie(result.portalSession.id, result.portalSession.expires));
    return response;
  } catch (error) {
    if (error instanceof NativeError) return NextResponse.json({ code: error.code }, { status: error.status });
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
