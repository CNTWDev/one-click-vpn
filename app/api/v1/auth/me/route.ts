import { NextResponse } from "next/server";
import { apiUser, publicUser } from "../../../../../server/device-auth";
import { jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ user: publicUser(user) });
}
