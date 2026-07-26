import { NextResponse } from "next/server";
import { addAudit, findUserByEmail } from "../../../../../server/db";
import { createApiSession } from "../../../../../server/control-db";
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
      await addAudit({ action: "api.auth.login.failed", metadata: { email } });
      return jsonError("Invalid email or password", 401);
    }
    if (user.status !== "active") {
      await addAudit({ actorUserId: user.id, action: "api.auth.login.blocked", metadata: { status: user.status } });
      return NextResponse.json({ error: `Account is ${user.status}`, code: `USER_${user.status.toUpperCase()}`, status: user.status }, { status: 403 });
    }
    const session = await createApiSession(user.id);
    await addAudit({ actorUserId: user.id, action: "api.auth.login.succeeded" });
    return NextResponse.json({ user: publicUser(user), accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.accessExpiresAt });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid request");
  }
}
