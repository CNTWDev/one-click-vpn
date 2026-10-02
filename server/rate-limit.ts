type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const buckets = new Map<string, Bucket>();

// Nginx overwrites X-Real-IP with the peer address, so clients cannot rotate it the way
// they can prepend entries to X-Forwarded-For.
export function clientAddress(request: Request): string {
  return request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim()
    || "local";
}

function hit(key: string, limit: number, now: number): boolean {
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    if (buckets.size >= MAX_ENTRIES) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
      if (buckets.size >= MAX_ENTRIES) buckets.delete(buckets.keys().next().value as string);
    }
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

/** Shared login throttle: 30 attempts per client address and 10 per account every 15 minutes. */
export function allowLoginAttempt(request: Request, email: string): boolean {
  const now = Date.now();
  const byAddress = hit(`ip:${clientAddress(request)}`, 30, now);
  const byAccount = email ? hit(`email:${email}`, 10, now) : true;
  return byAddress && byAccount;
}

export function allowRegistration(request: Request): boolean {
  return hit(`register:${clientAddress(request)}`, 10, Date.now());
}

export function allowSubscriptionFetch(request: Request, tokenHash: string): boolean {
  return hit(`subscription-ip:${clientAddress(request)}`, 300, Date.now())
    && hit(`subscription-token:${tokenHash}`, 60, Date.now());
}
