import { createHmac } from "node:crypto";
import { agentOrigin, masterKey } from "./config";
import { dbExec, dbQuery, getControllerSettings, listNodes } from "./db";
import { normalizeDomain } from "./sites";

// Nodes reach the Controller through one Agent domain that no site owns, so sites and their
// domains can change without touching nodes. Set in Console; empty falls back to VEILBIRD_AGENT_ORIGIN.

let cache: { domain: string; at: number } | null = null;
const CACHE_MS = 30_000;

async function storedDomain(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.domain;
  const row = (await dbQuery<{ agent_domain: string | null }>("SELECT agent_domain FROM controller_settings WHERE id = 'primary'"))[0];
  cache = { domain: row?.agent_domain || "", at: Date.now() };
  return cache.domain;
}

/** The origin new installs write into config.env and every heartbeat announces to running Agents. */
export async function currentAgentOrigin(): Promise<string> {
  const domain = await storedDomain();
  return domain ? `https://${domain}` : agentOrigin().replace(/\/+$/, "");
}

/** Identifies this deployment without revealing anything: a domain check compares it to tell "reaches us" from "reaches something". */
export function controllerId(): string {
  return createHmac("sha256", masterKey()).update("tracknothing-controller-id").digest("hex").slice(0, 16);
}

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function checkAgentDomain(domain: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`https://${domain}/api/v1/agent/whoami`, { signal: AbortSignal.timeout(8000), redirect: "manual", headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null) as { controllerId?: unknown } | null;
    return body?.controllerId === controllerId() ? { ok: true, detail: "" } : { ok: false, detail: "reaches a different server" };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    return { ok: false, detail: cause.slice(0, 160) };
  }
}

/** Saving is refused until the domain answers over HTTPS as this deployment, so nodes are only ever told a working domain. */
export async function setAgentDomain(value: unknown): Promise<void> {
  const domain = normalizeDomain(value);
  if (domain) {
    if (!DOMAIN.test(domain)) throw new Error("Agent domain is not a valid hostname");
    const check = await checkAgentDomain(domain);
    if (!check.ok) throw new Error(`https://${domain} does not reach this deployment yet: ${check.detail}`);
  }
  await getControllerSettings();
  await dbExec("UPDATE controller_settings SET agent_domain = $1, updated_at = $2 WHERE id = 'primary'", [domain, new Date().toISOString()]);
  cache = null;
}

export type AgentDomainStatus = {
  domain: string; origin: string; source: "console" | "environment"; environmentOrigin: string;
  nodes: Array<{ id: string; name: string; status: string; version: string; controllerOrigin: string }>;
};

export async function agentDomainStatus(): Promise<AgentDomainStatus> {
  const domain = await storedDomain();
  const nodes = (await listNodes()).map((node) => {
    let reported = "";
    try { reported = String((JSON.parse(String((node as { agent_capabilities_json?: string }).agent_capabilities_json || "{}")) as { controllerOrigin?: unknown }).controllerOrigin || ""); } catch { reported = ""; }
    return { id: node.id, name: node.name, status: node.status, version: node.version, controllerOrigin: reported };
  });
  return { domain, origin: await currentAgentOrigin(), source: domain ? "console" : "environment", environmentOrigin: agentOrigin().replace(/\/+$/, ""), nodes };
}
