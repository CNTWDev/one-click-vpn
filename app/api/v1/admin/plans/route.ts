import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../server/request-auth";
import { jsonError, readJson } from "../../../../../server/http";
import { EntitlementError, listPlans, savePlan } from "../../../../../server/entitlements";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!await requestAdmin(request)) return jsonError("Administrator authentication required", 403);
  return NextResponse.json({ plans: await listPlans() }, { headers: { "Cache-Control": "no-store" } });
}

/** Creates a plan, or updates the one named by `id`. */
export async function POST(request: Request) {
  const admin = await requestAdmin(request);
  if (!admin) return jsonError("Administrator authentication required", 403);
  try {
    const body = await readJson(request);
    return NextResponse.json({ plans: await savePlan(typeof body.id === "string" && body.id ? body.id : null, body as never, admin.id) });
  } catch (error) {
    return jsonError(error instanceof EntitlementError ? error.message : "操作失败，请稍后重试", error instanceof EntitlementError ? error.status : 503);
  }
}
