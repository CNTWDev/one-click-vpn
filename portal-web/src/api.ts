export type ApiError = Error & { status?: number; body?: Record<string, unknown> };

export function isUnauthorized(error: unknown): boolean {
  return (error as ApiError | null)?.status === 401;
}

function requestError(status: number, body: Record<string, unknown>): ApiError {
  return Object.assign(
    new Error(typeof body.error === "string" && body.error ? body.error : `请求失败（HTTP ${status}）`),
    { body, status },
  );
}

function parseJsonBody(text: string, isJson: boolean): Record<string, unknown> {
  if (!isJson || !text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

/** Fetches a plain-text resource (e.g. a config download); errors are parsed like api(). */
export async function fetchText(path: string): Promise<string> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw requestError(response.status, parseJsonBody(text, (response.headers.get("content-type") || "").includes("application/json")));
  return text;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  const text = await response.text();
  const body = parseJsonBody(text, isJson);
  if (!response.ok) throw requestError(response.status, body);
  if (!isJson) {
    throw Object.assign(
      new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查 Portal 的 /api/ 反向代理。`),
      { body, status: response.status },
    ) as ApiError;
  }
  return body as T;
}
