import { NextResponse } from "next/server";
import { addAudit, findUserByEmail } from "../../../../server/db";
import { createLoginSession, sessionCookie } from "../../../../server/auth";
import { verifyPassword } from "../../../../server/password";
import { jsonError, readJson, cleanText } from "../../../../server/http";
import { allowLoginAttempt } from "../../../../server/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!allowLoginAttempt(request, email)) return jsonError("Too many login attempts", 429);
    const user = await findUserByEmail(email);
    if (!(await verifyPassword(password, user?.password_hash)) || !user) {
      await addAudit({ action: "auth.login.failed", metadata: { email } });
      return jsonError("Invalid email or password", 401);
    }
    if (user.status !== "active" || !["owner", "admin"].includes(user.role)) {
      await addAudit({ actorUserId: user.id, action: "auth.login.blocked", metadata: { status: user.status, role: user.role } });
      return NextResponse.json({ error: "This account is not allowed to access the administrator console", code: `USER_${user.status.toUpperCase()}`, status: user.status }, { status: 403 });
    }
    const session = await createLoginSession(user.id, "admin");
    await addAudit({ actorUserId: user.id, action: "auth.login.succeeded" });
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, status: user.status },
    });
    response.headers.set("Set-Cookie", sessionCookie(session.id, session.expires));
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
