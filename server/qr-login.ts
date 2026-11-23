import { randomBytes, randomUUID } from "node:crypto";
import { addAudit, dbExec, dbQuery } from "./db";
import { digest, identity, NativeError } from "./native-proof";
import { cohortOf, readyGeo } from "./geo";
import { deviceSlots } from "./entitlements";
import { apiOrigins } from "./api-origins";
import { sessionDays, type Session } from "./native-access";
import { createLoginSession } from "./auth";

/**
 * Signing in a computer with the phone ("扫码登录电脑"): the Mac/Windows app or the Portal's login page shows a QR
 * code; the phone app, already signed in, scans it, shows which computer it is and from where, and the person
 * confirms. The computer then gets its own session (a native session bound to its device key, or a Portal cookie);
 * it counts towards the device limit when it connects, like a password sign-in.
 *
 * A code lives two minutes and is used once. Only hashes are stored: the code (in the QR) lets a phone scan and
 * approve, the secret (kept by the computer) lets the computer collect the session. Neither alone signs anyone in.
 */
export const qrTtlSeconds = 120;
const codePattern = /^[A-Za-z0-9_-]{32,64}$/;
type Row = { id: string; status: string; kind: string; platform: string; device_name: string; identity_jwk: string | null; identity_thumbprint: string | null;
  user_id: string | null; country: string | null; expires_at: Date };

async function prune() {
  await dbExec("DELETE FROM qr_logins WHERE expires_at < now() - interval '10 minutes'");
}

/** The computer asks for a code. kind "native": the Mac/Windows app with its device key; "portal": the Portal's login page. */
export async function createQrLogin(kind: "native" | "portal", body: Record<string, unknown>, address: string) {
  let platform = "web", deviceName = "", key: ReturnType<typeof identity> | null = null;
  if (kind === "native") {
    platform = String(body.platform);
    if (!["macos", "windows"].includes(platform)) throw new NativeError("INVALID_PLATFORM");
    key = identity(body.identityKey);
    deviceName = String(body.deviceName || platform).slice(0, 80);
  } else deviceName = String(body.deviceName || "").slice(0, 80);
  await readyGeo(1000);
  const country = cohortOf(address)?.country ?? null;
  const id = randomUUID(), code = randomBytes(24).toString("base64url"), secret = randomBytes(32).toString("base64url");
  await prune();
  // A burst from one address is refused: codes are cheap to make but each shows on a phone.
  const recent = Number((await dbQuery<{ count: string }>("SELECT COUNT(*) AS count FROM qr_logins WHERE created_address_hash=$1 AND created_at > now() - interval '10 minutes'", [digest(address || "-")]))[0]?.count || 0);
  if (recent >= 30) throw new NativeError("RATE_LIMITED", 429);
  await dbExec(`INSERT INTO qr_logins (id,code_hash,secret_hash,kind,status,platform,device_name,identity_jwk,identity_thumbprint,country,created_address_hash,expires_at)
    VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,now()+make_interval(secs=>$11))`,
  [id, digest(code), digest(secret), kind, platform, deviceName, key ? JSON.stringify(key.jwk) : null, key?.thumbprint ?? null, country, digest(address || "-"), qrTtlSeconds]);
  return { id, secret, code, qr: `tracknothing://qr-login?c=${code}`, expiresAt: new Date(Date.now() + qrTtlSeconds * 1000).toISOString(), ttl: qrTtlSeconds };
}

async function byCode(code: unknown): Promise<Row> {
  if (typeof code !== "string" || !codePattern.test(code)) throw new NativeError("QR_INVALID", 400);
  const row = (await dbQuery<Row>("SELECT * FROM qr_logins WHERE code_hash=$1", [digest(code)]))[0];
  if (!row) throw new NativeError("QR_INVALID", 404);
  if (new Date(row.expires_at).getTime() < Date.now() || row.status === "used" || row.status === "declined") throw new NativeError("QR_EXPIRED", 410);
  return row;
}

/** The phone scanned the code: marks it scanned (the computer shows "confirm on your phone") and says what it is. */
export async function scanQrLogin(session: Session, body: Record<string, unknown>) {
  const row = await byCode(body.code);
  if (row.status !== "pending" && !(row.status === "scanned" && row.user_id === session.user_id)) throw new NativeError("QR_EXPIRED", 410);
  await dbExec("UPDATE qr_logins SET status='scanned',user_id=$2 WHERE id=$1 AND status IN ('pending','scanned')", [row.id, session.user_id]);
  const slots = await deviceSlots(session.user_id);
  // The computer is new to the account unless its device key already has a device row.
  const known = row.identity_thumbprint ? (await dbQuery("SELECT 1 FROM native_enrollments WHERE user_id=$1 AND identity_thumbprint=$2 AND status='active'", [session.user_id, row.identity_thumbprint])).length > 0 : true;
  return { kind: row.kind, platform: row.platform, deviceName: row.device_name, country: row.country, expiresAt: new Date(row.expires_at).toISOString(),
    limit: slots.limit, used: slots.used, newDevice: !known && row.kind === "native" };
}

/** The person confirmed (or declined) on the phone. */
export async function approveQrLogin(session: Session, body: Record<string, unknown>) {
  const row = await byCode(body.code);
  if (row.status !== "scanned" || row.user_id !== session.user_id) throw new NativeError("QR_EXPIRED", 410);
  const approve = body.approve !== false;
  await dbExec("UPDATE qr_logins SET status=$2,approved_by_session=$3 WHERE id=$1 AND status='scanned'", [row.id, approve ? "approved" : "declined", session.id]);
  await addAudit({ actorUserId: session.user_id, action: approve ? "qr_login.approved" : "qr_login.declined", targetType: "qr_login", targetId: row.id, metadata: { platform: row.platform } });
  return { status: approve ? "approved" : "declined" };
}

/**
 * The computer asks every two seconds: pending, scanned, declined, expired, or (once) approved with its session.
 * Collecting marks the code used, so a second poll with the same secret gets nothing.
 */
export async function pollQrLogin(kind: "native" | "portal", body: Record<string, unknown>) {
  if (typeof body.id !== "string" || typeof body.secret !== "string") throw new NativeError("QR_INVALID", 400);
  const row = (await dbQuery<Row>("SELECT * FROM qr_logins WHERE id=$1 AND secret_hash=$2 AND kind=$3", [body.id, digest(body.secret), kind]))[0];
  if (!row || row.status === "used") return { status: "expired" as const };
  if (row.status === "declined") return { status: "declined" as const };
  if (new Date(row.expires_at).getTime() < Date.now()) return { status: "expired" as const };
  if (row.status !== "approved" || !row.user_id) return { status: row.status as "pending" | "scanned" };
  // Exactly one poll collects: the update is the lock.
  const claimed = await dbQuery<{ id: string }>("UPDATE qr_logins SET status='used' WHERE id=$1 AND status='approved' RETURNING id", [row.id]);
  if (!claimed.length) return { status: "expired" as const };
  const user = (await dbQuery<{ status: string }>("SELECT status FROM users WHERE id=$1", [row.user_id]))[0];
  if (user?.status !== "active") throw new NativeError("ACCOUNT_UNAVAILABLE", 403);
  if (kind === "portal") {
    const session = await createLoginSession(row.user_id, "portal");
    await addAudit({ actorUserId: row.user_id, action: "portal.auth.qr_login.succeeded", targetType: "qr_login", targetId: row.id });
    return { status: "approved" as const, portalSession: session };
  }
  const token = randomBytes(32).toString("base64url"), id = randomUUID();
  await dbExec(`INSERT INTO native_sessions (id,token_hash,user_id,identity_jwk,identity_thumbprint,device_name,platform,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8))`,
  [id, digest(token), row.user_id, row.identity_jwk, row.identity_thumbprint, row.device_name || row.platform, row.platform, sessionDays()]);
  // Like a password sign-in, a computer signed out earlier is admitted again; it counts against the limit on connect.
  await dbExec("DELETE FROM native_enrollments WHERE user_id=$1 AND identity_thumbprint=$2 AND (status='revoked' OR (status='revoking' AND release_after<=now()))", [row.user_id, row.identity_thumbprint]);
  await addAudit({ actorUserId: row.user_id, action: "native.qr_login", targetType: "native_session", targetId: id });
  return { status: "approved" as const, accessToken: token, expiresAt: new Date(Date.now() + sessionDays() * 86400000).toISOString(), apiOrigins: await apiOrigins() };
}
