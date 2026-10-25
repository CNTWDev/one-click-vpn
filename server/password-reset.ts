import { createHmac, timingSafeEqual } from "node:crypto";
import { addAudit, dbExec, dbQuery, findUserByEmail } from "./db";
import { masterKey, publicOrigin } from "./config";
import { hashPasswordAsync } from "./password";
import { revokeApiSessionsForUser } from "./control-db";
import { mailConfigured, passwordResetMail, sendMail } from "./mail";
import { writeOperationalLog } from "./operational-logs";
import { allowPasswordResetRequest } from "./rate-limit";
import { cleanText } from "./http";

// Reset links are stateless: nothing is stored. The signature covers the current password hash,
// so a link stops working the moment it (or any other link) is used, and simply expires otherwise.
export const EMAIL_LINK_TTL_SECONDS = 60 * 60;
export const ADMIN_LINK_TTL_SECONDS = 24 * 60 * 60;

function signature(userId: string, expires: number, passwordHash: string): string {
  const key = createHmac("sha256", masterKey()).update("veilbird-password-reset").digest();
  return createHmac("sha256", key).update(`${userId}\n${expires}\n${passwordHash}`).digest("base64url");
}

async function passwordHash(userId: string): Promise<{ hash: string; status: string; role: string } | undefined> {
  return (await dbQuery<{ hash: string; status: string; role: string }>("SELECT password_hash AS hash, status, role FROM users WHERE id = $1", [userId]))[0];
}

/** `portalOrigin` is the Portal of the site the request came from, so the link opens the brand the user knows. */
export async function createResetLink(userId: string, ttlSeconds: number, portalOrigin = publicOrigin()): Promise<{ url: string; expiresAt: string } | null> {
  const user = await passwordHash(userId);
  if (!user) return null;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = `${userId}.${expires}.${signature(userId, expires, user.hash)}`;
  return { url: `${portalOrigin}/#reset=${token}`, expiresAt: new Date(expires * 1000).toISOString() };
}

/** Sets the new password and signs the account out everywhere. Returns the user id, or null for a bad link. */
export async function resetPassword(token: string, password: string): Promise<string | null> {
  const [userId, expiresText, given] = token.split(".");
  const expires = Number(expiresText);
  if (!userId || !given || !Number.isInteger(expires) || expires * 1000 < Date.now()) return null;
  const user = await passwordHash(userId);
  if (!user || (user.status !== "active" && user.status !== "pending")) return null;
  const expected = Buffer.from(signature(userId, expires, user.hash));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const nextHash = await hashPasswordAsync(password);
  // Compare-and-set on the old hash so two concurrent uses of one link cannot both succeed.
  const updated = await dbQuery<{ id: string }>("UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3 AND password_hash = $4 RETURNING id", [nextHash, new Date().toISOString(), userId, user.hash]);
  if (!updated.length) return null;
  await Promise.all([
    dbExec("DELETE FROM sessions WHERE user_id = $1", [userId]),
    dbExec("DELETE FROM native_sessions WHERE user_id = $1", [userId]),
    revokeApiSessionsForUser(userId),
  ]);
  return userId;
}

export type ResetRequestResult = "received" | "invalid" | "limited" | "unconfigured";

/**
 * "Forgot password" for the Portal and the apps: emails a one-hour link. Unknown addresses get the
 * same answer and the mail goes out in the background, so the reply never reveals whether an email exists.
 */
export async function requestPasswordResetEmail(request: Request, rawEmail: unknown, language: unknown): Promise<ResetRequestResult> {
  if (!(await mailConfigured())) return "unconfigured";
  const email = cleanText(rawEmail, 320).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return "invalid";
  if (!allowPasswordResetRequest(request, email)) return "limited";
  const user = await findUserByEmail(email);
  if (user && (user.status === "active" || user.status === "pending")) {
    void (async () => {
      try {
        const link = await createResetLink(user.id, EMAIL_LINK_TTL_SECONDS);
        if (!link) return;
        await sendMail({ to: user.email, ...passwordResetMail(language, link.url) });
        await addAudit({ actorUserId: user.id, action: "auth.password_reset.requested", targetType: "user", targetId: user.id });
      } catch (error) {
        await writeOperationalLog({ component: "controller", level: "error", message: `Password reset email failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    })();
  }
  return "received";
}
