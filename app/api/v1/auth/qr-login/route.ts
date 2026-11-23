import { NextResponse } from "next/server";
import { jsonError, readJson } from "../../../../../server/http";
import { NativeError } from "../../../../../server/native-proof";
import { clientAddress } from "../../../../../server/rate-limit";
import { createQrLogin } from "../../../../../server/qr-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Portal's login page (desktop width) asks for a code to show as a QR for the phone app (server/qr-login.ts). */
export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const created = await createQrLogin("portal", { deviceName: typeof body.deviceName === "string" ? body.deviceName : "" }, clientAddress(request));
    return NextResponse.json(created, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof NativeError) return NextResponse.json({ code: error.code }, { status: error.status });
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
