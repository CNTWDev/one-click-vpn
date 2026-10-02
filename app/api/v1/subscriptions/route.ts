import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { createSubscription, downloadSubscription, listSubscriptions, manageSubscription } from "../../../../server/subscriptions";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ subscriptions: await listSubscriptions(user.id) }, { headers });
}
export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request), name = cleanText(body.name, 120);
    if (!name || !["wireguard", "vless"].includes(String(body.protocol))) return jsonError("请填写名称并选择连接方式");
    const subscription = await createSubscription(user.id,name,body.protocol as "wireguard" | "vless");
    // Prepare initial access now; the first agent acknowledgement arrives asynchronously.
    try { await downloadSubscription(subscription.token); } catch { /* Keep the link; don't mint a second identity on retry. */ }
    return NextResponse.json(subscription, { status: 201, headers });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "创建失败", 409); }
}
export async function PATCH(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request);
    return NextResponse.json(await manageSubscription(cleanText(body.id,128),cleanText(body.action,32),{ id: user.id, admin: false }), { headers });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "操作失败", 409); }
}
