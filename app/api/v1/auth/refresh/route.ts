import { NextResponse } from "next/server";
import { jsonError, cleanText, readJson } from "../../../../../server/http";
import { publicUser, refreshBearerSession } from "../../../../../server/device-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const result = await refreshBearerSession(cleanText(body.refreshToken, 1024));
    if (!result) return jsonError("Invalid or expired refresh token", 401);
    if (result.user.status !== "active") return jsonError(`Account is ${result.user.status}`, 403);
    return NextResponse.json({ user: publicUser(result.user), accessToken: result.session.accessToken, refreshToken: result.session.refreshToken, expiresAt: result.session.accessExpiresAt });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
