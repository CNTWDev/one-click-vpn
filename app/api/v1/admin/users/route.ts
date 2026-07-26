import { NextResponse } from "next/server";
import { listUsers } from "../../../../../server/db";
import { publicUser } from "../../../../../server/device-auth";
import { requestAdmin } from "../../../../../server/request-auth";
import { cleanText, jsonError } from "../../../../../server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const status = cleanText(new URL(request.url).searchParams.get("status"), 20) as "pending" | "active" | "rejected" | "suspended" | "";
  const users = await listUsers(status || undefined);
  return NextResponse.json({ users: users.map(publicUser) });
}
