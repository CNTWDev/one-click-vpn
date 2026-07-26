import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { createSession, deleteSession, findSession, findUserById, cleanupSessions, type DbUser } from "./db";
import { sessionTtlSeconds } from "./config";

export const SESSION_COOKIE = "northstar_session";

export async function currentUser(): Promise<DbUser | null> {
  await cleanupSessions();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  const session = await findSession(sessionId);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return (await findUserById(session.user_id)) || null;
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

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
