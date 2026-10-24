import { randomUUID } from "node:crypto";
import { PRODUCT_NAME } from "../shared/brand-name";
import { apiOrigin, publicOrigin } from "./config";
import { dbExec, dbQuery, withTransaction } from "./db";

// A site is one brand on top of the shared engine: its own name, logo and three hostnames
// (user portal, console, API/subscriptions). Accounts, nodes and the Agent's system domain are shared.
export type Site = {
  id: string; name: string; portalDomain: string; consoleDomain: string; apiDomain: string;
  logoSvg: string; mailFromName: string; isDefault: boolean; createdAt: string; updatedAt: string;
};
export type SiteInput = { name: string; portalDomain: string; consoleDomain: string; apiDomain: string; logoSvg: string; mailFromName: string };
/** What the Portal and Console need to brand themselves; safe to serve without authentication. */
export type SiteBrand = { id: string; name: string; logoSvg: string; isDefault: boolean; portalOrigin: string; consoleOrigin: string; apiOrigin: string };

type Row = { id: string; name: string; portal_domain: string; console_domain: string; api_domain: string; logo_svg: string; mail_from_name: string; is_default: boolean; created_at: string; updated_at: string };

const fromRow = (row: Row): Site => ({ id: row.id, name: row.name, portalDomain: row.portal_domain, consoleDomain: row.console_domain, apiDomain: row.api_domain,
  logoSvg: row.logo_svg, mailFromName: row.mail_from_name, isDefault: row.is_default, createdAt: row.created_at, updatedAt: row.updated_at });

let cache: { sites: Site[]; at: number } | null = null;
const CACHE_MS = 30_000;

export async function listSites(): Promise<Site[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.sites;
  const sites = (await dbQuery<Row>("SELECT * FROM sites ORDER BY is_default DESC, created_at")).map(fromRow);
  cache = { sites, at: Date.now() };
  return sites;
}

const hostOf = (origin: string) => { try { return new URL(origin).hostname; } catch { return ""; } };

/** Used before any site exists (fresh install, tests): the .env origins under the product name. */
function builtInSite(): Site {
  const now = new Date(0).toISOString();
  return { id: "default", name: PRODUCT_NAME, portalDomain: hostOf(publicOrigin()), consoleDomain: "", apiDomain: hostOf(apiOrigin()),
    logoSvg: "", mailFromName: "", isDefault: true, createdAt: now, updatedAt: now };
}

/** The hostname the browser or client asked for; the frontends and Nginx both pass it through. */
export function requestHost(request: Request): string {
  const raw = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  return raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

/** The site whose portal, console or API hostname was requested; unknown hosts get the default site. */
export async function siteForRequest(request: Request): Promise<Site> {
  const host = requestHost(request);
  const sites = await listSites();
  return sites.find((site) => host && [site.portalDomain, site.consoleDomain, site.apiDomain].includes(host))
    || sites.find((site) => site.isDefault) || sites[0] || builtInSite();
}

/** Sites are served over HTTPS; a hostname that is also a configured .env origin keeps that origin (scheme and port, as in development). */
const origin = (domain: string, fallback = "") => {
  if (!domain) return fallback;
  for (const configured of [publicOrigin(), apiOrigin()]) if (hostOf(configured) === domain) return configured.replace(/\/+$/, "");
  return `https://${domain}`;
};

export function siteBrand(site: Site): SiteBrand {
  const portal = origin(site.portalDomain, publicOrigin());
  return { id: site.id, name: site.name, logoSvg: site.logoSvg, isDefault: site.isDefault, portalOrigin: portal, consoleOrigin: origin(site.consoleDomain), apiOrigin: origin(site.apiDomain, portal) };
}

/** Clash group names appear in rules as "MATCH,<name>", so commas and line breaks are not allowed. */
export function proxyGroupName(site: Site): string {
  return site.name.replace(/[,\r\n"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || PRODUCT_NAME;
}

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

/**
 * Accepts only a self-contained SVG document. Logos are always shown through <img>, where scripts never run,
 * but script-like content is still refused so a stored logo stays harmless wherever it is used later.
 */
export function cleanLogoSvg(value: unknown): string {
  const svg = String(value ?? "").trim();
  if (!svg) return "";
  if (svg.length > 48 * 1024) throw new Error("Logo must be smaller than 48 KB");
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new Error("Logo must be an SVG file");
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!ENTITY|(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(svg)) throw new Error("Logo SVG must not contain scripts, event handlers or external links");
  return svg;
}

export function validateSiteInput(body: Record<string, unknown>): SiteInput {
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new Error("Site name is required");
  const portalDomain = normalizeDomain(body.portalDomain);
  const consoleDomain = normalizeDomain(body.consoleDomain);
  const apiDomain = normalizeDomain(body.apiDomain);
  for (const [label, domain, required] of [["Portal", portalDomain, true], ["Console", consoleDomain, false], ["API", apiDomain, true]] as const) {
    if (!domain && required) throw new Error(`${label} domain is required`);
    if (domain && !DOMAIN.test(domain)) throw new Error(`${label} domain is not a valid hostname`);
  }
  const own = [portalDomain, consoleDomain, apiDomain].filter(Boolean);
  if (new Set(own).size !== own.length) throw new Error("Each domain can be used only once");
  return { name, portalDomain, consoleDomain, apiDomain, logoSvg: cleanLogoSvg(body.logoSvg), mailFromName: String(body.mailFromName ?? "").replace(/["\r\n]/g, "").trim().slice(0, 80) };
}

async function assertDomainsFree(input: SiteInput, exceptId?: string) {
  for (const site of await dbQuery<Row>("SELECT * FROM sites WHERE id <> $1", [exceptId || ""])) {
    const taken = [site.portal_domain, site.console_domain, site.api_domain].filter(Boolean);
    const clash = [input.portalDomain, input.consoleDomain, input.apiDomain].find((domain) => domain && taken.includes(domain));
    if (clash) throw new Error(`${clash} is already used by site ${site.name}`);
  }
}

export async function createSite(input: SiteInput): Promise<Site> {
  await assertDomainsFree(input);
  const now = new Date().toISOString();
  const id = `site_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const first = !(await dbQuery<{ id: string }>("SELECT id FROM sites LIMIT 1")).length;
  await dbExec(`INSERT INTO sites (id, name, portal_domain, console_domain, api_domain, logo_svg, mail_from_name, is_default, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`, [id, input.name, input.portalDomain, input.consoleDomain, input.apiDomain, input.logoSvg, input.mailFromName, first, now]);
  cache = null;
  return (await listSites()).find((site) => site.id === id)!;
}

export async function updateSite(id: string, input: SiteInput): Promise<Site | null> {
  await assertDomainsFree(input, id);
  const changed = await dbExec(`UPDATE sites SET name = $2, portal_domain = $3, console_domain = $4, api_domain = $5, logo_svg = $6, mail_from_name = $7, updated_at = $8 WHERE id = $1`,
    [id, input.name, input.portalDomain, input.consoleDomain, input.apiDomain, input.logoSvg, input.mailFromName, new Date().toISOString()]);
  cache = null;
  return changed ? (await listSites()).find((site) => site.id === id) || null : null;
}

export async function makeDefaultSite(id: string): Promise<boolean> {
  if (!(await dbQuery<{ id: string }>("SELECT id FROM sites WHERE id = $1", [id])).length) return false;
  // Two statements: the partial unique index allows only one default row at any moment.
  await withTransaction(async (exec) => {
    await exec("UPDATE sites SET is_default = FALSE WHERE is_default AND id <> $1", [id]);
    await exec("UPDATE sites SET is_default = TRUE, updated_at = $2 WHERE id = $1", [id, new Date().toISOString()]);
  });
  cache = null;
  return true;
}

/** The default site carries the system defaults (unknown hosts, native apps), so it cannot be deleted. */
export async function deleteSite(id: string): Promise<void> {
  const site = (await dbQuery<Row>("SELECT * FROM sites WHERE id = $1", [id]))[0];
  if (!site) throw new Error("Site not found");
  if (site.is_default) throw new Error("The default site cannot be deleted");
  await dbExec("DELETE FROM sites WHERE id = $1", [id]);
  cache = null;
}

export type DomainCheck = { role: "portal" | "console" | "api"; domain: string; status: "ok" | "other-site" | "unreachable"; detail: string };

/**
 * HTTPS works and the reverse proxy forwards the hostname (Host: $host) only if /api/v1/site on that
 * hostname answers with this site's id. Each check is a single request with a short timeout.
 */
export async function checkSiteDomains(site: Site): Promise<DomainCheck[]> {
  const targets = ([["portal", site.portalDomain], ["console", site.consoleDomain], ["api", site.apiDomain]] as const).filter(([, domain]) => domain);
  return Promise.all(targets.map(async ([role, domain]): Promise<DomainCheck> => {
    try {
      const response = await fetch(`https://${domain}/api/v1/site`, { signal: AbortSignal.timeout(8000), redirect: "manual", headers: { Accept: "application/json" } });
      if (!response.ok) return { role, domain, status: "unreachable", detail: `HTTP ${response.status}` };
      const brand = await response.json().catch(() => null) as Partial<SiteBrand> | null;
      if (brand?.id === site.id) return { role, domain, status: "ok", detail: "" };
      return { role, domain, status: "other-site", detail: brand?.name ? String(brand.name) : "unknown response" };
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
      return { role, domain, status: "unreachable", detail: cause.slice(0, 160) };
    }
  }));
}
