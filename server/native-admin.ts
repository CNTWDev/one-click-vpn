import { addAudit, dbQuery } from "./db";
import { defaultLimit, nativeAccount, transaction } from "./native-access";
import { NativeError } from "./native-proof";
import { reconcileUserAccess } from "./credential-access";

export async function accountDevices(userId: string) {
  if (!(await dbQuery("SELECT id FROM users WHERE id=$1", [userId])).length) throw new NativeError("USER_NOT_FOUND",404);
  return nativeAccount({user_id:userId,id:"",identity_jwk:"",identity_thumbprint:"",device_name:"",platform:""});
}

export async function updateNativeAccess(userId: string, actor: string, body: Record<string,unknown>) {
  await accountDevices(userId);
  if (body.action === "revoke") {
    await transaction(async c => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[userId]);
      const rows=await c.query(`UPDATE native_enrollments SET status='revoking',release_after=GREATEST(now(),COALESCE((SELECT MAX(expires_at) FROM native_leases WHERE enrollment_id=$2),now()))+interval '20 seconds'
        WHERE user_id=$1 AND id=$2 AND status='active' RETURNING id`,[userId,body.enrollmentId]);
      if (!rows.rowCount) throw new NativeError("DEVICE_NOT_FOUND",404);
      await c.query("UPDATE native_leases SET expires_at=now() WHERE enrollment_id=$1",[body.enrollmentId]);
    });
  } else if (body.action === "settings") {
    const limit=body.limit;
    if (limit !== null && (!Number.isInteger(limit) || Number(limit)<1 || Number(limit)>100)) throw new NativeError("INVALID_DEVICE_LIMIT");
    if (typeof body.managed !== "boolean") throw new NativeError("INVALID_REQUEST");
    if (body.expiresAt !== null && (typeof body.expiresAt!=="string" || !Number.isFinite(Date.parse(body.expiresAt)))) throw new NativeError("INVALID_EXPIRY");
    await transaction(async c => {
      const user=(await c.query("SELECT native_only FROM users WHERE id=$1 FOR UPDATE",[userId])).rows[0];
      // Do not promise strict isolation while previously exported credentials can still exist on offline nodes.
      if (body.managed && !user.native_only && (await c.query("SELECT p.id FROM connection_profiles p JOIN devices d ON d.id=p.device_id WHERE d.user_id=$1 LIMIT 1",[userId])).rowCount) throw new NativeError("LEGACY_ACCESS_MIGRATION_REQUIRED",409);
      const used=Number((await c.query("SELECT COUNT(*) AS count FROM native_enrollments WHERE user_id=$1 AND status<>'revoked'",[userId])).rows[0].count);
      if (used > (limit === null ? defaultLimit() : Number(limit))) throw new NativeError("REVOKE_DEVICES_FIRST",409,{used});
      if (!body.managed && used) throw new NativeError("REVOKE_DEVICES_FIRST",409,{used});
      await c.query("UPDATE users SET native_only=$2,native_device_limit=$3,membership_expires_at=$4 WHERE id=$1",[userId,body.managed,limit,body.expiresAt ? new Date(String(body.expiresAt)).toISOString():null]);
    });
  } else throw new NativeError("INVALID_REQUEST");
  await reconcileUserAccess(userId);
  await addAudit({actorUserId:actor,action:`native.admin.${body.action}`,targetType:"user",targetId:userId});
  return accountDevices(userId);
}
