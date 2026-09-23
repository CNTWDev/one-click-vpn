import { NextResponse } from "next/server";
import { listUsers } from "../../../../../server/db";
import { publicUser } from "../../../../../server/device-auth";
import { requestAdmin } from "../../../../../server/request-auth";
import { cleanText, jsonError } from "../../../../../server/http";
import { adminUserAccessSummaries } from "../../../../../server/traffic";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const status = cleanText(new URL(request.url).searchParams.get("status"), 20) as "pending" | "active" | "rejected" | "suspended" | "";
  const users = await listUsers(status || undefined);
  const summaries = await adminUserAccessSummaries();
  return NextResponse.json({ users: users.map((user) => ({ ...publicUser(user), accessSummary: summaries.get(user.id) || {
    deviceCount: 0, activeDeviceCount: 0, credentialCount: 0, activeCredentialCount: 0, profileCount: 0, activeProfileCount: 0,
    certificateCount: 0, activeCertificateCount: 0, uploadBytes: 0, downloadBytes: 0, totalBytes: 0, lastActivityAt: null,
  } })) });
}
