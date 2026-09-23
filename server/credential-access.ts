import { addAudit, dbExec, dbQuery, findUserById } from "./db";
import { findAccessCredential, listConnectionProfiles, listVpnServices } from "./control-db";
import { rebuildDesiredState, revokeCredentialAndReconcile } from "./control-plane";

export type CredentialAction = "enable" | "disable" | "revoke" | "delete";

export async function assertCredentialUsable(id: string) {
  const credential = await findAccessCredential(id);
  if (!credential || credential.deleted_at || credential.status !== "active" || credential.user_disabled || credential.admin_disabled
    || (credential.expires_at && credential.expires_at <= new Date().toISOString())) {
    throw new Error("Credential is disabled, expired or revoked");
  }
  if ((await findUserById(credential.user_id))?.status !== "active") throw new Error("Account is not active");
  return credential;
}

// OpenVPN credentials are valid across the fleet. WireGuard peers are node-specific.
export async function reconcileUserAccess(userId: string) {
  const profiles = await listConnectionProfiles({ userId });
  const services = (await listVpnServices()).filter((service) => service.enabled);
  const affected = services.filter((service) => (service.protocol === "openvpn" && profiles.some((profile) => profile.protocol === "openvpn"))
    || profiles.some((profile) => profile.node_id === service.node_id && profile.protocol === service.protocol));
  const failures: string[] = [];
  for (const service of affected) {
    try {
      await rebuildDesiredState(service.node_id, service.protocol, { force: true });
      await dbExec("UPDATE desired_configs SET status = 'pending' WHERE node_id = $1 AND protocol = $2", [service.node_id, service.protocol]);
      await dbExec("UPDATE vpn_services SET access_sync_error = '' WHERE node_id = $1 AND protocol = $2", [service.node_id, service.protocol]);
    }
    catch {
      failures.push(service.node_id);
      await dbExec("UPDATE vpn_services SET access_sync_error = 'Unable to schedule access update' WHERE node_id = $1 AND protocol = $2", [service.node_id, service.protocol]);
      await dbExec("UPDATE desired_configs SET status = 'failed' WHERE node_id = $1 AND protocol = $2", [service.node_id, service.protocol]);
    }
  }
  return { status: failures.length ? "failed" : affected.length ? "pending" : "applied", failedNodeIds: failures };
}

export async function credentialSyncStatus(credentialId: string, protocol: string) {
  const rows = await dbQuery<{ pending: boolean; failed: boolean }>(`SELECT
      (d.node_id IS NULL OR t.id IS NULL OR t.status <> 'succeeded' OR t.desired_revision <> d.revision) AS pending,
      (s.access_sync_error <> '' OR COALESCE(t.status = 'failed' OR d.status = 'failed', FALSE)) AS failed
    FROM vpn_services s
    LEFT JOIN desired_configs d ON d.node_id = s.node_id AND d.protocol = s.protocol
    LEFT JOIN LATERAL (SELECT rt.id, rt.status, rt.desired_revision FROM reconcile_tasks rt
      WHERE rt.node_id = s.node_id AND rt.protocol = s.protocol ORDER BY rt.created_at DESC, rt.id DESC LIMIT 1) t ON TRUE
    WHERE s.enabled = 1 AND s.protocol = $2 AND ($2 = 'openvpn' OR EXISTS
      (SELECT 1 FROM connection_profiles p WHERE p.credential_id = $1 AND p.node_id = s.node_id AND p.protocol = s.protocol))`, [credentialId, protocol]);
  return rows.some((row) => row.failed) ? "failed" : rows.some((row) => row.pending) ? "pending" : "applied";
}

export async function manageCredentialAccess(id: string, action: CredentialAction, actor: { id: string; admin: boolean }, deferReconcile = false) {
  const credential = await findAccessCredential(id);
  if (!credential || credential.deleted_at || (!actor.admin && credential.user_id !== actor.id)) throw new Error("Credential not found");
  if (action === "enable" || action === "disable") {
    if (credential.status !== "active" || (credential.expires_at && credential.expires_at <= new Date().toISOString())) {
      throw new Error("Revoked or expired credentials cannot be enabled or disabled");
    }
    if (action === "enable" && !actor.admin && credential.admin_disabled) throw new Error("This credential is disabled by an administrator");
    const column = actor.admin ? "admin_disabled" : "user_disabled";
    await dbExec(`UPDATE access_credentials SET ${column} = $1, updated_at = $2 WHERE id = $3 AND status = 'active' AND deleted_at IS NULL`,
      [action === "disable", new Date().toISOString(), id]);
  } else {
    await revokeCredentialAndReconcile(id, actor.id, true);
    if (action === "delete") await dbExec("UPDATE access_credentials SET deleted_at = $1, updated_at = $1 WHERE id = $2", [new Date().toISOString(), id]);
  }
  await addAudit({ actorUserId: actor.id, action: `credential.${action}`, targetType: "credential", targetId: id, metadata: { administrator: actor.admin } });
  return { ok: true, sync: deferReconcile ? { status: "pending", failedNodeIds: [] } : await reconcileUserAccess(credential.user_id) };
}

export async function manageCredentialsAccess(userId: string, ids: string[], action: CredentialAction, actor: { id: string; admin: boolean }) {
  for (const id of ids) {
    if ((await findAccessCredential(id))?.user_id !== userId) throw new Error("Credential not found");
  }
  let sync;
  try {
    for (const id of ids) await manageCredentialAccess(id, action, actor, true);
  } finally {
    // Even a partially completed batch must propagate its restrictions.
    sync = await reconcileUserAccess(userId);
  }
  return { ok: true, count: ids.length, sync };
}
