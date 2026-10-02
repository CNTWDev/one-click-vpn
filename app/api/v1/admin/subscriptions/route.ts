import { NextResponse } from "next/server";
import { requestAdmin } from "../../../../../server/request-auth";
import { cleanText, jsonError, readJson } from "../../../../../server/http";
import { listSubscriptions, manageSubscription } from "../../../../../server/subscriptions";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!(await requestAdmin(request))) return jsonError("Administrator required", 403);
  return NextResponse.json({ subscriptions: await listSubscriptions() }, { headers: { "Cache-Control": "no-store" } });
}
export async function PATCH(request: Request) {
  const user = await requestAdmin(request);
  if (!user) return jsonError("Administrator required", 403);
  try {
    const body = await readJson(request);
    // The console manages access; private subscription links are only handed to their owner.
    if (body.action === "reset-link") return jsonError("请由用户在个人平台重置订阅链接");
    return NextResponse.json(await manageSubscription(cleanText(body.id,128),cleanText(body.action,32),{ id: user.id, admin: true }));
  } catch (error) { return jsonError(error instanceof Error ? error.message : "操作失败", 409); }
}
