import { NextResponse } from "next/server";
import { addAudit, findUserByEmail } from "../../../../server/db";
import { createLoginSession, sessionCookie } from "../../../../server/auth";
import { verifyPassword } from "../../../../server/password";
import { jsonError, readJson, cleanText } from "../../../../server/http";

export const runtime = "nodejs";

const attempts = new Map<string, { count: number; resetAt: number }>();

function allowed(request: Request): boolean {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const current = attempts.get(address);
  if (!current || current.resetAt <= now) {
    attempts.set(address, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= 20;
}

export async function POST(request: Request) {
  try {
    if (!allowed(request)) return jsonError("Too many login attempts", 429);
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      addAudit({ action: "auth.login.failed", metadata: { email } });
      return jsonError("Invalid email or password", 401);
    }
    const session = createLoginSession(user.id);
    addAudit({ actorUserId: user.id, action: "auth.login.succeeded" });
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    });
    response.headers.set("Set-Cookie", sessionCookie(session.id, session.expires));
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
