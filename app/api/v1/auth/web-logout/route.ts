import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession } from "../../../../../server/db";
import { clearPortalSessionCookie, PORTAL_SESSION_COOKIE } from "../../../../../server/auth";

export const runtime = "nodejs";

export async function POST() {
  const cookieStore = await cookies();
  const id = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;
  if (id) await deleteSession(id);
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearPortalSessionCookie());
  return response;
}
