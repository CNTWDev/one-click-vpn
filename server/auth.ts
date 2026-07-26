import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { createSession, deleteSession, findSession, findUserById, cleanupSessions, type DbUser } from "./db";
import { sessionTtlSeconds } from "./config";

export const SESSION_COOKIE = "northstar_session";
export const PORTAL_SESSION_COOKIE = "northstar_portal_session";

async function currentUserForCookie(cookieName: string): Promise<DbUser | null> {
  await cleanupSessions();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(cookieName)?.value;
  if (!sessionId) return null;
  const session = await findSession(sessionId);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return (await findUserById(session.user_id)) || null;
}

export async function currentUser(): Promise<DbUser | null> {
  return currentUserForCookie(SESSION_COOKIE);
}

export async function currentPortalUser(): Promise<DbUser | null> {
  return currentUserForCookie(PORTAL_SESSION_COOKIE);
}

export async function requireUser(): Promise<DbUser> {
  const user = await currentUser();
  if (!user) throw new Response("Unauthorized", { status: 401 });
  return user;
}

export async function createLoginSession(userId: string): Promise<{ id: string; expires: Date }> {
  const id = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + sessionTtlSeconds() * 1000);
  await createSession(userId, expires.toISOString(), id);
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
