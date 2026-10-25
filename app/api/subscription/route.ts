import { downloadSubscription } from "../../../server/subscriptions";
import { allowSubscriptionFetch } from "../../../server/rate-limit";
import { hashToken } from "../../../server/crypto";
import { routingMode, subscriptionFormat } from "../../../server/subscription-format";
import { proxyGroupName, siteForRequest } from "../../../server/sites";
import { AccessEndedError, DeviceLimitReachedError } from "../../../server/credential-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get("token") || "";
  // Reject malformed tokens before they take a rate-limit slot that could evict login buckets.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return new Response("订阅不可用或节点正在同步。请确认访问权限，稍后刷新。", { status: 503, headers: { ...headers, "Retry-After": "30" } });
  if (!allowSubscriptionFetch(request,hashToken(token))) return new Response("请稍后重试", { status: 429, headers: { ...headers, "Retry-After": "900" } });
  try {
    const group = proxyGroupName(await siteForRequest(request));
    const result = await downloadSubscription(token, { format: subscriptionFormat(params.get("format"), request.headers.get("user-agent")), mode: routingMode(params.get("mode")), group });
    const yaml = result.format === "clash";
    return new Response(result.content, { headers: { ...headers, "Content-Type": yaml ? "application/yaml; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(group)}.${yaml ? "yaml" : "txt"}"`, "profile-update-interval": "1",
      "subscription-userinfo": [`upload=0`, `download=${result.usedBytes}`, ...(result.quotaBytes ? [`total=${result.quotaBytes}`] : []),
        ...(result.expiresAt ? [`expire=${Math.floor(new Date(result.expiresAt).getTime()/1000)}`] : [])].join("; ") } });
  } catch (error) {
    if (error instanceof AccessEndedError || error instanceof DeviceLimitReachedError) return new Response(error.message, { status: 403, headers });
    // Never return an empty successful config (clients would replace working nodes), SQL errors, tokens or keys.
    return new Response("订阅不可用或节点正在同步。请确认访问权限，稍后刷新。", { status: 503, headers: { ...headers, "Retry-After": "30" } });
  }
}
