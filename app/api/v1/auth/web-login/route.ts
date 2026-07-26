import { NextResponse } from "next/server";
import { addAudit, findUserByEmail } from "../../../../../server/db";
import { createLoginSession, portalSessionCookie } from "../../../../../server/auth";
import { publicUser } from "../../../../../server/device-auth";
import { verifyPassword } from "../../../../../server/password";
import { cleanText, jsonError, readJson } from "../../../../../server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const email = cleanText(body.email, 320).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      await addAudit({ action: "portal.auth.login.failed", metadata: { email } });
      return jsonError("Invalid email or password", 401);
    }
    if (user.status !== "active") return NextResponse.json({ user: publicUser(user), error: `Account is ${user.status}`, code: `USER_${user.status.toUpperCase()}` }, { status: 403 });
    const session = await createLoginSession(user.id);
    await addAudit({ actorUserId: user.id, action: "portal.auth.login.succeeded" });
    const response = NextResponse.json({ user: publicUser(user) });
    response.headers.set("Set-Cookie", portalSessionCookie(session.id, session.expires));
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
