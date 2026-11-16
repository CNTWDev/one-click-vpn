import { createHmac, timingSafeEqual } from "node:crypto";
import { masterKey } from "./config";
import { dbQuery, listNodes } from "./db";
import { agentReleaseVersion, hasSshCredential, queueNodeAction } from "./bootstrap";
import { supportsSelfUpgrade } from "./agent-self-upgrade";

// one-click-update.sh upgrades the Agents after a deploy (scripts/agent-rollout.mjs, run inside the
// Controller container). It proves it runs on this host with a key derived from VEILBIRD_MASTER_KEY, which
// only the server's .env holds, and the route refuses anything that came through the host's Nginx.
const PURPOSE = "veilbird:deploy-agent-rollout";

export function rolloutToken(): string {
  return createHmac("sha256", masterKey()).update(PURPOSE).digest("hex");
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

export function isRolloutRequest(request: Request): boolean {
  // Next fills x-forwarded-for with the socket address when a request has none, so a call made inside the
  // container carries only a loopback address; one that came through Nginx carries the client's.
  if (request.headers.get("x-real-ip")) return false;
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (forwarded.some((address) => !LOOPBACK.test(address))) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
  const expected = Buffer.from(rolloutToken());
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const FRESH_MS = 90_000;

export async function rolloutPlan() {
  const release = agentReleaseVersion();
  const nodes = (await listNodes()).map((node) => {
    const seen = node.last_heartbeat_at ? new Date(node.last_heartbeat_at).getTime() : 0;
    let capabilities: Record<string, unknown> = {};
    try { capabilities = JSON.parse((node as { agent_capabilities_json?: string }).agent_capabilities_json || "{}"); } catch { /* none reported */ }
    return {
      id: node.id, name: node.name, version: node.version, users: Number(node.users) || 0,
      online: Number.isFinite(seen) && Date.now() - seen <= FRESH_MS,
      // Agents before 2.17 are upgraded over SSH, which needs the stored credential.
      upgradable: supportsSelfUpgrade(capabilities) || hasSshCredential(node),
    };
  });
  return { release, nodes: nodes.filter((node) => node.version !== release) };
}

export async function startRollout(nodeIds: string[]): Promise<Array<{ nodeId: string; actionId?: string; error?: string }>> {
  const results: Array<{ nodeId: string; actionId?: string; error?: string }> = [];
  for (const nodeId of nodeIds) {
    try { results.push({ nodeId, actionId: await queueNodeAction(nodeId, "upgrade-agent") }); }
    catch (error) { results.push({ nodeId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export async function rolloutStatus(actionIds: string[]) {
  if (!actionIds.length) return [];
  return dbQuery<{ id: string; node_id: string; status: string; error: string | null }>(
    "SELECT id, node_id, status, error FROM node_actions WHERE id = ANY($1::text[])", [actionIds]);
}
