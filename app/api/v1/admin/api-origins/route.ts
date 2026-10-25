import { NextResponse } from "next/server";
import { apiOrigins, backupApiDomains, setBackupApiDomains } from "../../../../../server/api-origins";
import { addAudit } from "../../../../../server/db";
import { jsonError, readJson } from "../../../../../server/http";
import { requestAdmin } from "../../../../../server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function status() {
  return { backupDomains: await backupApiDomains(), origins: await apiOrigins() };
}

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await status());
}

export async function PUT(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    await setBackupApiDomains(body.domains);
    const result = await status();
    await addAudit({ actorUserId: admin.id, action: "api_origins.updated", targetType: "controller", targetId: "primary", metadata: { backupDomains: result.backupDomains } });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save backup API domains");
  }
}
