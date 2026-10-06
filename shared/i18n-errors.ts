import type { Translator } from "./i18n-core";

// Match exact server messages only. Never translate names, identifiers or arbitrary user content.
const errorSources: Record<string, string> = {
  "Invalid email or password": "邮箱或密码不正确",
  "Too many login attempts": "请求过于频繁，请稍后重试",
  "Too many registration attempts": "请求过于频繁，请稍后重试",
  "A valid email is required": "请输入有效的邮箱",
  "A display name is required": "称呼至少需要两个字符",
  "Password must be at least 12 characters": "密码至少需要 12 个字符",
  "Authentication required": "请重新登录",
  "Failed to fetch": "网络连接失败，请检查网络后重试",
  "Load failed": "网络连接失败，请检查网络后重试",
  "NetworkError when attempting to fetch resource.": "网络连接失败，请检查网络后重试",
  "Credential not found": "连接不存在",
  "Profile not found": "配置不存在",
  "Credential name is required": "请输入连接名称，不能只包含空格。",
  "Profile has expired; create a replacement credential": "连接已到期，请换发后重新导入。",
};
export function errorText(message: string, t: Translator): string {
  const http = /^请求失败（HTTP (\d+)）$/.exec(message);
  if (http) return t("请求失败（HTTP {0}）", [http[1]]);
  const nonJson = /^API 返回了非 JSON 响应（HTTP (\d+)）/.exec(message);
  if (nonJson) return t("服务响应异常，请联系管理员（HTTP {0}）", [nonJson[1]]);
  // Unknown diagnostics remain intact so support can identify the failure.
  return t(errorSources[message] || message);
}
