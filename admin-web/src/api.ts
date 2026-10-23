import { localError, t } from "./i18n";
export type ApiError = Error & { status?: number; requestId?: string };

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
    const message = typeof body.error === "string" && body.error ? localError(body.error) : t("请求失败（HTTP {0}）", [response.status]);
    // The Controller logs every rejected request (except 401/404) under this id; searching it on the Runtime logs page shows the cause.
    const requestId = response.status !== 401 && response.status !== 404 ? response.headers.get("x-request-id") : null;
    throw Object.assign(new Error(requestId ? t("{0}（请求 ID {1}）", [message, requestId]) : message), { status: response.status, requestId: requestId || undefined }) as ApiError;
  }
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error(t("API 返回了非 JSON 响应（HTTP {0}），请检查 Console 的 /api/ 反向代理。", [response.status])), { status: response.status }) as ApiError;
  }
  return body as T;
}
