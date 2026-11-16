import { NextResponse } from "next/server";
import { requestUser } from "../../../../server/request-auth";
import { cleanText, jsonError, readJson } from "../../../../server/http";
import { accountSubscription, manageSubscription, resetAccountSubscriptionLink } from "../../../../server/subscriptions";
import { findUserByEmail } from "../../../../server/db";
import { verifyPassword } from "../../../../server/password";
import { allowLoginAttempt, recordAuthFailure } from "../../../../server/rate-limit";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/** The account's one subscription (with its link, for its signed-in owner), or null before first use. */
export async function GET(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  return NextResponse.json({ subscription: await accountSubscription(user.id) }, { headers });
}

/** First use: makes the account's subscription. Calling it again returns the same one. */
export async function POST(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try { return NextResponse.json({ subscription: await accountSubscription(user.id, true) }, { headers }); }
  catch (error) { return jsonError(error instanceof Error ? error.message : "创建失败", 409); }
}

/** reset-link (password checked, the old link stops at once); delete of a subscription from before accounts had one. */
export async function PATCH(request: Request) {
  const user = await requestUser(request);
  if (!user) return jsonError("Authentication required", 401);
  try {
    const body = await readJson(request), action = cleanText(body.action, 32);
    if (action === "reset-link") {
      if (!allowLoginAttempt(request, user.email)) return jsonError("验证次数过多，请稍后重试", 429);
      const account = await findUserByEmail(user.email);
      if (!(await verifyPassword(typeof body.password === "string" ? body.password : "", account?.password_hash))) {
        recordAuthFailure(request, "wrong-password");
        return jsonError("登录密码不正确", 403);
      }
      return NextResponse.json({ subscription: await resetAccountSubscriptionLink(user.id) }, { headers });
    }
    if (action !== "delete") return jsonError("不支持的订阅操作");
    return NextResponse.json(await manageSubscription(cleanText(body.id,128),action,{ id: user.id, admin: false }), { headers });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "操作失败", 409); }
}
