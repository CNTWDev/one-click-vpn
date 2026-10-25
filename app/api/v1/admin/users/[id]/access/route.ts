import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../../../server/request-auth";
import { jsonError, readJson } from "../../../../../../../server/http";
import { reconcileUserAccess } from "../../../../../../../server/credential-access";
import { describe, deviceSlots, EntitlementError, grantAccess, publicGrant, revokeGrant, userGrants } from "../../../../../../../server/entitlements";

export const runtime = "nodejs";

async function view(userId: string) {
  const [grants, devices] = await Promise.all([userGrants(userId), deviceSlots(userId)]);
  // devices: the limit from the account's plan (null = unlimited) and what takes one.
  return { access: describe(grants), devices, grants: grants.map((grant) => publicGrant(grant)) };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json(await view((await context.params).id), { headers: { "Cache-Control": "no-store" } });
}

/** { action: "switch", planId } | { action: "grant", planId } | { action: "grant", days | endsAt, quotaGb, deviceLimit, gift, note } | { action: "revoke", grantId } */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  const { id } = await context.params;
  try {
    const body = await readJson(request);
    const number = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
    if (body.action === "grant") {
      const quotaGb = number(body.quotaGb);
      await grantAccess(id, {
        planId: typeof body.planId === "string" && body.planId ? body.planId : null,
        days: number(body.days), endsAt: typeof body.endsAt === "string" && body.endsAt ? body.endsAt : null,
        quotaBytes: quotaGb === null ? null : Math.round(quotaGb * 1024 ** 3), deviceLimit: number(body.deviceLimit),
        source: body.gift === true ? "gift" : "admin", note: typeof body.note === "string" ? body.note : "", actorId: admin.id,
      });
    } else if (body.action === "switch" && typeof body.planId === "string" && body.planId) {
      await grantAccess(id, { planId: body.planId, source: "admin", replace: true, note: typeof body.note === "string" ? body.note : "", actorId: admin.id });
    } else if (body.action === "revoke" && typeof body.grantId === "string") await revokeGrant(id, body.grantId, admin.id);
    else return jsonError("Unsupported action");
    // Re-admit or drop the account on its nodes now instead of on their next heartbeat.
    await reconcileUserAccess(id).catch(() => undefined);
    return NextResponse.json(await view(id));
  } catch (error) {
    return jsonError(error instanceof EntitlementError ? error.message : "操作失败，请稍后重试", error instanceof EntitlementError ? error.status : 503);
  }
}
