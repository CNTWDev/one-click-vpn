import { parseClientAgent, type ClientAgent, type ClientPlatform } from "../shared/client-releases";
import { downloadPath, minimumBuild } from "./client-releases";
import { randomUUID } from "node:crypto";
import { dbExec, dbQuery } from "./db";
import { digest, NativeError } from "./native-proof";

export const clientHeader = "x-veilbird-client";

/**
 * Reads `X-Veilbird-Client: <platform>/<version>+<build>` and blocks builds below the configured minimum.
 * A missing or mismatched header counts as build 0, so clients that predate the header are blocked too
 * once an administrator sets a minimum (no minimum is set by default).
 */
export async function requireSupportedClient(request: Request, platform: ClientPlatform): Promise<ClientAgent | null> {
  const parsed = parseClientAgent(request.headers.get(clientHeader));
  const agent = parsed?.platform === platform ? parsed : null;
  const minBuild = await minimumBuild(platform);
  if (minBuild > 0 && (agent?.build ?? 0) < minBuild) throw new NativeError("CLIENT_UPDATE_REQUIRED", 426, { minBuild, downloadPath: downloadPath(platform) });
  return agent;
}

export async function recordSessionClient(accessToken: string, agent: ClientAgent | null) {
  if (agent) await dbExec("UPDATE native_sessions SET client_version=$2,client_build=$3 WHERE token_hash=$1", [digest(accessToken), agent.version, agent.build]);
}

export async function recordEnrollmentClient(enrollmentId: string, agent: ClientAgent | null) {
  if (agent) await dbExec("UPDATE native_enrollments SET client_version=$2,client_build=$3 WHERE id=$1", [enrollmentId, agent.version, agent.build]);
}

const diagnosticCode = /^[A-Z][A-Z0-9_]{1,63}$/, diagnosticNode = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Connection failure reports from installed clients: error codes only, never
 * configuration, keys or traffic. Bounded per request, per user and in age.
 */
export async function recordDiagnostics(session: { user_id: string; platform: string }, agent: ClientAgent | null, body: Record<string, unknown>) {
  const now = Date.now();
  const events = (Array.isArray(body.events) ? body.events.slice(0, 20) : []).flatMap((item: unknown) => {
    const event = item as Record<string, unknown> | null;
    const at = typeof event?.at === "string" ? Date.parse(event.at) : NaN;
    if (!event || typeof event.code !== "string" || !diagnosticCode.test(event.code) || !Number.isFinite(at) || at < now - 7 * 86400000 || at > now + 300000) return [];
    return [{ code: event.code, at: new Date(at).toISOString(), nodeId: typeof event.nodeId === "string" && diagnosticNode.test(event.nodeId) ? event.nodeId : null }];
  });
  const recent = Number((await dbQuery<{ count: string }>("SELECT COUNT(*) AS count FROM native_diagnostics WHERE user_id=$1 AND created_at>now()-interval '1 hour'", [session.user_id]))[0]?.count || 0);
  const accepted = events.slice(0, Math.max(0, 200 - recent));
  for (const event of accepted) {
    await dbExec("INSERT INTO native_diagnostics (id,user_id,platform,client_version,client_build,code,node_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [`diag_${randomUUID()}`, session.user_id, session.platform, agent?.version ?? null, agent?.build ?? null, event.code, event.nodeId, event.at]);
  }
  await dbExec("DELETE FROM native_diagnostics WHERE created_at<now()-interval '30 days'");
  return { accepted: accepted.length };
}
