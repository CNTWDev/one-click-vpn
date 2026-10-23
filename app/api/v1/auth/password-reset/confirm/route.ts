import { NextResponse } from "next/server";
import { addAudit } from "../../../../../../server/db";
import { cleanText, jsonError, readJson } from "../../../../../../server/http";
import { resetPassword } from "../../../../../../server/password-reset";
import { allowLoginAttempt } from "../../../../../../server/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!allowLoginAttempt(request, "")) return jsonError("Too many login attempts", 429);
    const body = await readJson(request);
    const token = cleanText(body.token, 512);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 12) return jsonError("Password must be at least 12 characters");
    const userId = await resetPassword(token, password);
    if (!userId) return jsonError("This reset link is invalid or has expired", 400);
    await addAudit({ actorUserId: userId, action: "auth.password_reset.completed", targetType: "user", targetId: userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
