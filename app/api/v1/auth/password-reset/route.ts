import { NextResponse } from "next/server";
import { jsonError, readJson } from "../../../../../server/http";
import { mailConfigured } from "../../../../../server/mail";
import { requestPasswordResetEmail } from "../../../../../server/password-reset";

export const runtime = "nodejs";

/** Tells the Portal whether "forgot password" can send an email or the user must ask an administrator. */
export async function GET() {
  return NextResponse.json({ email: await mailConfigured() });
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await requestPasswordResetEmail(request, body.email, body.language);
    if (result === "unconfigured") return jsonError("Email delivery is not configured", 503);
    if (result === "invalid") return jsonError("A valid email is required");
    if (result === "limited") return jsonError("Too many requests", 429);
    return NextResponse.json({ status: "received" }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
