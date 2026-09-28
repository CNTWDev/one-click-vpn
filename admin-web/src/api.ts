export type ApiError = Error & { status?: number };

let unauthorizedHandler: (() => void) | null = null;

/** Registers a callback invoked when an authenticated API call returns 401 (expired/revoked session). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function isUnauthorized(error: unknown): boolean {
  return (error as ApiError | null)?.status === 401;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (response.status === 401 && !path.startsWith("/api/auth/")) unauthorizedHandler?.();
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (contentType.includes("application/json") && text) {
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
  }
  if (!response.ok) {
    throw Object.assign(new Error(typeof body.error === "string" && body.error ? body.error : `请求失败（HTTP ${response.status}）`), { status: response.status }) as ApiError;
  }
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查 Console 的 /api/ 反向代理。`), { status: response.status }) as ApiError;
  }
  return body as T;
}
