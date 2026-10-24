import { createHash } from "node:crypto";

type Window = { count: number; resetAt: number };
type Bucket = { tokens: number; at: number };
type Failures = { count: number; resetAt: number; bannedUntil: number };
type BanListener = (address: string, reason: string) => void;
type Store = { windows: Map<string, Window>; buckets: Map<string, Bucket>; failures: Map<string, Failures>; onBan?: BanListener };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const MAX_BUCKETS = 50_000;
/** Authentication failures from one address within FAILURE_WINDOW_MS before it is banned. */
export const BAN_THRESHOLD = 40;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const BAN_MS = 60 * 60 * 1000;

// proxy.ts and the route handlers are bundled separately, so the counters live on globalThis:
// a ban recorded by a login route must be seen by the proxy on the next request.
const store: Store = ((globalThis as Record<symbol, unknown>)[Symbol.for("veilbird.rate-limit")] ??= {
  windows: new Map(), buckets: new Map(), failures: new Map(),
}) as Store;

// Nginx overwrites X-Real-IP with the peer address, so clients cannot rotate it the way
// they can prepend entries to X-Forwarded-For.
export function clientAddress(request: Request): string {
  return request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    || "local";
}

function hit(key: string, limit: number, now: number): boolean {
  const current = store.windows.get(key);
  if (!current || current.resetAt <= now) {
    if (store.windows.size >= MAX_ENTRIES) {
      for (const [windowKey, window] of store.windows) if (window.resetAt <= now) store.windows.delete(windowKey);
      if (store.windows.size >= MAX_ENTRIES) store.windows.delete(store.windows.keys().next().value as string);
    }
    store.windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

/** Token bucket: up to `capacity` at once, refilled at `perSecond`. Returns seconds to wait, or 0. */
function take(key: string, capacity: number, perSecond: number, now: number): number {
  const current = store.buckets.get(key);
  const tokens = current ? Math.min(capacity, current.tokens + ((now - current.at) / 1000) * perSecond) : capacity;
  // Re-inserting keeps the Map in least-recently-used order, so eviction drops idle clients first.
  store.buckets.delete(key);
  if (store.buckets.size >= MAX_BUCKETS) store.buckets.delete(store.buckets.keys().next().value as string);
  if (tokens < 1) {
    store.buckets.set(key, { tokens, at: now });
    return Math.ceil((1 - tokens) / perSecond);
  }
  store.buckets.set(key, { tokens: tokens - 1, at: now });
  return 0;
}

const fingerprint = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 22);

/** server/operational-logs.ts registers the Loki writer here, keeping this module free of imports for proxy.ts. */
export function setBanListener(listener: BanListener): void {
  store.onBan = listener;
}

/** Records one failed authentication (wrong password, unknown Agent node id). Returns true when it bans the address. */
export function recordAuthFailure(request: Request, reason: string): boolean {
  const address = clientAddress(request), now = Date.now();
  if (address === "local") return false;
  let entry = store.failures.get(address);
  if (!entry || (entry.resetAt <= now && entry.bannedUntil <= now)) {
    if (store.failures.size >= MAX_ENTRIES) store.failures.delete(store.failures.keys().next().value as string);
    entry = { count: 0, resetAt: now + FAILURE_WINDOW_MS, bannedUntil: 0 };
    store.failures.set(address, entry);
  }
  if (entry.bannedUntil > now) return false;
  entry.count += 1;
  if (entry.count < BAN_THRESHOLD) return false;
  entry.bannedUntil = now + BAN_MS;
  try { store.onBan?.(address, reason); } catch { /* logging is best-effort */ }
  return true;
}

/** Seconds left on a ban for this request's address, or 0. */
export function banRemaining(request: Request): number {
  const entry = store.failures.get(clientAddress(request));
  return entry && entry.bannedUntil > Date.now() ? Math.ceil((entry.bannedUntil - Date.now()) / 1000) : 0;
}

function credential(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S{16,512})$/i)?.[1];
  if (bearer) return fingerprint(bearer);
  const session = request.headers.get("cookie")?.match(/(?:^|;\s*)(veilbird(?:_portal)?_session)=([^;]{16,512})/);
  return session ? fingerprint(session[2]) : null;
}

const publicReads = new Set(["/api/health", "/api/v1/health", "/api/v1/availability", "/api/v1/site", "/api/v1/client-releases", "/api/v1/client-releases/latest"]);

/**
 * Per-request limits applied by proxy.ts before any route runs. Generous enough for the Console, the
 * apps and Agents (task poll every 5 s); a script hammering one endpoint gets 429 without a database hit.
 * Requests without X-Real-IP come from this host (health checks, tests), never through Nginx: not limited.
 * Returns seconds to wait, or 0.
 */
export function apiRetryAfter(request: Request, pathname: string): number {
  if (process.env.VEILBIRD_RATE_LIMIT === "off") return 0;
  const address = clientAddress(request);
  if (address === "local") return 0;
  const banned = banRemaining(request);
  if (banned) return banned;
  const now = Date.now();
  const checks: [string, number, number][] = [[`ip:${address}`, 300, 10]];
  const owner = credential(request);
  if (owner) checks.push([`owner:${owner}`, 120, 2]);
  if (pathname.startsWith("/api/v2/native/")) {
    // A connect polls status once a second for up to 15 s; everything else is occasional.
    if (owner) checks.push(pathname.startsWith("/api/v2/native/status/") ? [`native-status:${owner}`, 30, 0.5] : [`native:${owner}`, 60, 1]);
  } else if (pathname.startsWith("/api/v1/agent/")) {
    checks.push([`agent:${address}`, 60, 1]);
  } else if (pathname.startsWith("/download/") || pathname.startsWith("/api/v1/client-releases/download/") || pathname.startsWith("/api/v1/client-releases/files/")) {
    checks.push([`download:${address}`, 30, 30 / 3600]);
  } else if (publicReads.has(pathname)) {
    checks.push([`public:${address}`, 60, 1]);
  }
  let wait = 0;
  for (const [key, capacity, perSecond] of checks) wait = Math.max(wait, take(key, capacity, perSecond, now));
  return wait;
}

/** Shared login throttle: 30 attempts per client address and 10 per account every 15 minutes. */
export function allowLoginAttempt(request: Request, email: string): boolean {
  const now = Date.now();
  const byAddress = hit(`ip:${clientAddress(request)}`, 30, now);
  const byAccount = email ? hit(`email:${email}`, 10, now) : true;
  // Retrying after a 429 counts towards a ban, so waiting out the window is the only way through.
  if (!(byAddress && byAccount)) recordAuthFailure(request, "login-throttled");
  return byAddress && byAccount;
}

export function allowRegistration(request: Request): boolean {
  return hit(`register:${clientAddress(request)}`, 10, Date.now());
}

export function allowSubscriptionFetch(request: Request, tokenHash: string): boolean {
  return hit(`subscription-ip:${clientAddress(request)}`, 300, Date.now())
    && hit(`subscription-token:${tokenHash}`, 60, Date.now());
}

/** Reset emails: 10 per client address and 3 per account every 15 minutes. */
export function allowPasswordResetRequest(request: Request, email: string): boolean {
  const now = Date.now();
  const byAddress = hit(`reset-ip:${clientAddress(request)}`, 10, now);
  const byAccount = hit(`reset-email:${email}`, 3, now);
  return byAddress && byAccount;
}
