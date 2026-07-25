import { findApiUserByAccessToken, revokeApiSession, rotateApiSession, type ApiSession } from "./control-db";
import type { DbUser } from "./db";

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : null;
}

export function apiUser(request: Request): DbUser | null {
  const token = bearerToken(request);
  return token ? findApiUserByAccessToken(token) || null : null;
}

export function revokeBearerSession(request: Request): void {
  const token = bearerToken(request);
  if (token) revokeApiSession(token);
}

export function refreshBearerSession(refreshToken: string): { user: DbUser; session: ApiSession } | null {
  return rotateApiSession(refreshToken) || null;
}

export function publicUser(user: DbUser) {
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
}

