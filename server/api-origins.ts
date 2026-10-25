import { checkAgentDomain } from "./agent-domain";
import { dbExec, dbQuery, getControllerSettings } from "./db";
import { listSites, normalizeDomain, siteBrand } from "./sites";

// Every hostname the apps may use to reach the API, in the order to try: the API domain of each site, then
// the backup domains set in Console → 站点. Accounts are shared by all sites, so any of them works for any
// account; an app that cannot reach its own domain (blocked DNS or SNI) moves on to the next one and
// remembers what worked (clients/core/fetch.go). They all lead to this one server: they help against a
// blocked name, not against a blocked IP address.

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
let cache: { domains: string[]; at: number } | null = null;

export async function backupApiDomains(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.domains;
  const row = (await dbQuery<{ backup_api_domains: string }>("SELECT backup_api_domains FROM controller_settings WHERE id = 'primary'"))[0];
  const domains = (row?.backup_api_domains || "").split(",").map((item) => item.trim()).filter(Boolean);
  cache = { domains, at: Date.now() };
  return domains;
}

export async function apiOrigins(): Promise<string[]> {
  const sites = (await listSites()).map((site) => siteBrand(site).apiOrigin);
  return [...new Set([...sites, ...(await backupApiDomains()).map((domain) => `https://${domain}`)])].slice(0, 12);
}

/** Each domain must already answer as this deployment over HTTPS, so apps are only ever given working entries. */
export async function setBackupApiDomains(value: unknown): Promise<Array<{ domain: string; ok: boolean; detail: string }>> {
  const list = [...new Set(String(value ?? "").split(/[\s,;，；]+/).map(normalizeDomain).filter(Boolean))];
  if (list.length > 8) throw new Error("At most 8 backup API domains");
  for (const domain of list) if (!DOMAIN.test(domain)) throw new Error(`${domain} is not a valid hostname`);
  const checks = await Promise.all(list.map(async (domain) => ({ domain, ...await checkAgentDomain(domain) })));
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) throw new Error(failed.map((check) => `https://${check.domain} does not reach this deployment yet: ${check.detail}`).join("; "));
  await getControllerSettings();
  await dbExec("UPDATE controller_settings SET backup_api_domains = $1, updated_at = $2 WHERE id = 'primary'", [list.join(","), new Date().toISOString()]);
  cache = null;
  return checks;
}
