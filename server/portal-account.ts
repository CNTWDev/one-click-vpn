import { addAudit, dbQuery } from "./db";
import { transaction } from "./native-access";
import { NativeError } from "./native-proof";
import { rebuildDesiredState } from "./control-plane";
import { accountAccess, deviceSlots } from "./entitlements";

export type PortalDevice = { id: string; name: string; platform: string; lastSeenAt: string; connected: boolean; region: string | null };

/** What the Portal home shows: the account's access (period, traffic, devices) and the apps signed in to it. */
export async function portalAccount(userId: string) {
  if (!(await dbQuery("SELECT id FROM users WHERE id=$1", [userId])).length) throw new NativeError("USER_NOT_FOUND", 404);
  // A live lease means the app is connected right now; its node gives the region.
  const devices = await dbQuery<PortalDevice>(`SELECT e.id,e.device_name AS name,e.platform,e.last_seen_at AS "lastSeenAt",
      (l.node_id IS NOT NULL) AS connected,COALESCE(r.name,NULLIF(n.region,'')) AS region
    FROM native_enrollments e
    LEFT JOIN LATERAL (SELECT node_id FROM native_leases WHERE enrollment_id=e.id AND expires_at>now() ORDER BY expires_at DESC LIMIT 1) l ON true
    LEFT JOIN nodes n ON n.id=l.node_id LEFT JOIN regions r ON r.id=n.region_id
    WHERE e.user_id=$1 AND e.status='active' ORDER BY connected DESC,e.last_seen_at DESC`, [userId]);
  const [access, slots] = await Promise.all([accountAccess(userId), deviceSlots(userId)]);
  // deviceLimit null = unlimited; deviceCount includes subscriptions and node configs, which take a device too.
  return { expiresAt: access.state === "active" ? access.until : access.endedAt, access, deviceLimit: slots.limit, deviceCount: slots.used, devices };
}

/** Signs one app out: its login sessions end, its tunnel stops, and its device slot frees once the last lease lapses. */
export async function signOutDevice(userId: string, enrollmentId: string) {
  const affected = await transaction(async (client) => {
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const row = (await client.query(`UPDATE native_enrollments SET status='revoking',release_after=GREATEST(now(),COALESCE((SELECT MAX(expires_at) FROM native_leases WHERE enrollment_id=$2),now()))+interval '20 seconds'
      WHERE user_id=$1 AND id=$2 AND status='active' RETURNING identity_thumbprint`, [userId, enrollmentId])).rows[0];
    if (!row) throw new NativeError("DEVICE_NOT_FOUND", 404);
    await client.query("DELETE FROM native_sessions WHERE user_id=$1 AND identity_thumbprint=$2", [userId, row.identity_thumbprint]);
    return (await client.query("UPDATE native_leases SET expires_at=now() WHERE enrollment_id=$1 RETURNING node_id", [enrollmentId])).rows.map((r) => r.node_id as string);
  });
  for (const nodeId of affected) await rebuildDesiredState(nodeId, "wireguard").catch(() => undefined);
  await addAudit({ actorUserId: userId, action: "native.portal_signout", targetType: "native_enrollment", targetId: enrollmentId });
  return portalAccount(userId);
}
