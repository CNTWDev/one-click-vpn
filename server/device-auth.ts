import { findApiUserByAccessToken, revokeApiSession, rotateApiSession, type ApiSession } from "./control-db";
import type { DbUser } from "./db";

export function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : null;
}

export async function apiUser(request: Request): Promise<DbUser | null> {
  const token = bearerToken(request);
  return token ? (await findApiUserByAccessToken(token)) || null : null;
}

export async function revokeBearerSession(request: Request): Promise<void> {
  const token = bearerToken(request);
  if (token) await revokeApiSession(token);
}

export async function refreshBearerSession(refreshToken: string): Promise<{ user: DbUser; session: ApiSession } | null> {
  return (await rotateApiSession(refreshToken)) || null;
}

export function publicUser(user: DbUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    approvedAt: user.approved_at,
    rejectionReason: user.rejection_reason,
    createdAt: user.created_at,
  };
}
