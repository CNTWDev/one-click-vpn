import { useMemo, useSyncExternalStore } from "react";

// Hash routes (#/nodes?focus=id&filter=offline) so refresh, back/forward and shared links keep the view.
export type Route = { page: string; query: URLSearchParams };
type Params = Record<string, string | null | undefined>;

const ROUTE_EVENT = "veilbird:route";
function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  window.addEventListener(ROUTE_EVENT, callback);
  return () => { window.removeEventListener("hashchange", callback); window.removeEventListener(ROUTE_EVENT, callback); };
}
const snapshot = () => window.location.hash;

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const index = raw.indexOf("?");
  const page = (index < 0 ? raw : raw.slice(0, index)).replace(/\/+$/, "");
  return { page, query: new URLSearchParams(index < 0 ? "" : raw.slice(index + 1)) };
}

export function href(page: string, params: Params = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return `#/${page}${text ? `?${text}` : ""}`;
}

/** Push a new history entry (page change or opening a detail view). */
export function navigate(page: string, params: Params = {}) {
  const next = href(page, params);
  if (next === window.location.hash) return;
  window.location.hash = next;
}

/** Merge query parameters into the current route. Filters replace history by default; pass push for detail views. */
export function setQuery(patch: Params, mode: "replace" | "push" = "replace") {
  const current = parseHash(window.location.hash);
  for (const [key, value] of Object.entries(patch)) {
    if (value) current.query.set(key, value); else current.query.delete(key);
  }
  const text = current.query.toString();
  const next = `#/${current.page}${text ? `?${text}` : ""}`;
  if (next === window.location.hash) return;
  if (mode === "push") window.history.pushState(null, "", next);
  else window.history.replaceState(null, "", next);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return useMemo(() => parseHash(hash), [hash]);
}

/** A single query parameter as state; the default value is kept out of the URL. */
export function useQueryParam(key: string, fallback = ""): [string, (value: string) => void] {
  const { query } = useRoute();
  return [query.get(key) ?? fallback, (value: string) => setQuery({ [key]: value === fallback ? null : value })];
}
