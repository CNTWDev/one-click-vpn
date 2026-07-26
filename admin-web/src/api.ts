export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查 Console 的 /api/ 反向代理。`);
  }
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}
