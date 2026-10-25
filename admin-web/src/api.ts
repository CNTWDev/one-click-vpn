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

/** True when the request never got an HTTP answer (connection dropped, Controller restarting, offline). */
export function isNetworkError(error: unknown): boolean {
  return (error as ApiError | null)?.status === 0;
}

export function networkErrorMessage(): string {
  return t("无法连接 Controller（网络中断或服务正在重启），请稍后重试。");
}

// fetch() rejects with a bare TypeError ("Failed to fetch" / "Load failed") when no HTTP answer arrives.
// Reads are retried twice, since a restart or a dropped connection usually lasts a second or two; writes are
// not, because the first attempt may already have reached the Controller.
async function send(path: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const retries = method === "GET" || method === "HEAD" ? [1_000, 2_000] : [];
  for (let attempt = 0; ; attempt += 1) {
    try { return await fetch(path, init); }
    catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      if (attempt >= retries.length) throw Object.assign(new Error(networkErrorMessage()), { status: 0 }) as ApiError;
      await new Promise((resolve) => setTimeout(resolve, retries[attempt]));
    }
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, {
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
