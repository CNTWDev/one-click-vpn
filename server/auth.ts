import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { createSession, deleteSession, findSession, findUserById, cleanupSessions, type DbUser } from "./db";
import { sessionTtlSeconds } from "./config";

export const SESSION_COOKIE = "veilbird_session";
export const PORTAL_SESSION_COOKIE = "veilbird_portal_session";

export type SessionKind = "admin" | "portal";

const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupAt = 0;

async function maybeCleanupSessions(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  await cleanupSessions();
}

async function currentUserForCookie(cookieName: string, kind: SessionKind): Promise<DbUser | null> {
  await maybeCleanupSessions();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(cookieName)?.value;
  if (!sessionId) return null;
  const session = await findSession(sessionId, kind);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  const user = (await findUserById(session.user_id)) || null;
  return user?.status === "active" ? user : null;
}

/** Administrator console session: only admin-kind sessions held by an owner or admin qualify. */
export async function currentUser(): Promise<DbUser | null> {
  const user = await currentUserForCookie(SESSION_COOKIE, "admin");
  return user && ["owner", "admin"].includes(user.role) ? user : null;
}

export async function currentPortalUser(): Promise<DbUser | null> {
  return currentUserForCookie(PORTAL_SESSION_COOKIE, "portal");
}

/** Whoever is signed in on this request (Console first, then Portal), for log attribution only. */
export async function requestActor(): Promise<{ id: string; email: string; role: string } | null> {
  for (const [cookie, kind] of [[SESSION_COOKIE, "admin"], [PORTAL_SESSION_COOKIE, "portal"]] as const) {
    try {
      const user = await currentUserForCookie(cookie, kind);
      if (user) return { id: user.id, email: user.email, role: user.role };
    } catch {
      // No request scope or no database: the line is still logged, just without an actor.
    }
  }
  return null;
}

export async function createLoginSession(userId: string, kind: SessionKind): Promise<{ id: string; expires: Date }> {
  const id = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + sessionTtlSeconds() * 1000);
  await createSession(userId, expires.toISOString(), id, kind);
  return { id, expires };
}

export async function expireLoginSession(id: string | undefined): Promise<void> {
  if (id) await deleteSession(id);
}

export function sessionCookie(value: string, expires: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))}${secure}`;
}

export function portalSessionCookie(value: string, expires: Date): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${PORTAL_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000))}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function clearPortalSessionCookie(): string {
  return `${PORTAL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
