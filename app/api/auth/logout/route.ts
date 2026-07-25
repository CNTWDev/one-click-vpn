import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { addAudit } from "../../../../server/db";
import { currentUser, expireLoginSession, SESSION_COOKIE, clearSessionCookie } from "../../../../server/auth";

export const runtime = "nodejs";

export async function POST() {
  const user = await currentUser();
  const cookieStore = await cookies();
  expireLoginSession(cookieStore.get(SESSION_COOKIE)?.value);
  if (user) addAudit({ actorUserId: user.id, action: "auth.logout" });
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearSessionCookie());
  return response;
}
