import { useSyncExternalStore } from "react";
import { PRODUCT_NAME } from "./brand-name";

/** The brand of the hostname this page was opened on (GET /api/v1/site). Same shape as server/sites.ts SiteBrand. */
export type SiteBrand = { id: string; name: string; logoSvg: string; isDefault: boolean; portalOrigin: string; consoleOrigin: string; apiOrigin: string };

let current: SiteBrand | null = null;
const listeners = new Set<() => void>();

/** Until the controller answers (or if it cannot), pages show the default product on their own origin. */
export const fallbackSite = (): SiteBrand => ({ id: "default", name: PRODUCT_NAME, logoSvg: "", isDefault: true,
  portalOrigin: window.location.origin, consoleOrigin: "", apiOrigin: window.location.origin });

let request: Promise<SiteBrand> | null = null;
/** Fetched once per page load; every caller shares the same request. */
export function loadSite(): Promise<SiteBrand> {
  request ||= fetch("/api/v1/site", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((response): Promise<Partial<SiteBrand>> | Partial<SiteBrand> => response.ok ? response.json() : {})
    .catch((): Partial<SiteBrand> => ({}))
    .then((value) => {
      const fallback = fallbackSite();
      current = typeof value.name === "string" && value.name ? { ...fallback, ...value } as SiteBrand : fallback;
      listeners.forEach((listener) => listener());
      return current;
    });
  return request;
}

/** `null` while loading, so a brand never flashes the wrong name before the real one arrives. */
export function useSite(): SiteBrand | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); void loadSite(); return () => listeners.delete(listener); }, () => current);
}

export const logoDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Tab title and favicon follow the site; the built-in favicon stays when the site has no logo of its own. */
export function applySiteToDocument(site: SiteBrand, suffix = "") {
  document.title = suffix ? `${site.name} ${suffix}` : site.name;
  if (!site.logoSvg) return;
  const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']") || document.head.appendChild(Object.assign(document.createElement("link"), { rel: "icon" }));
  icon.type = "image/svg+xml";
  icon.href = logoDataUrl(site.logoSvg);
}
