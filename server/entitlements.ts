import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { addAudit, dbQuery, getDb } from "./db";

/**
 * Account entitlements. An account may connect while it holds a grant that is inside its time window
 * and has traffic left. Admin grants, gifts, the welcome gift and (later) paid orders are all grants;
 * nothing else decides access. users.access_ok / access_until / access_device_limit cache the result
 * so every enforcement point checks one row with {@link accessSql}.
 */

export type GrantSource = "admin" | "gift" | "welcome" | "order" | "migration";
export type AccessState = "active" | "expired" | "exhausted" | "none";

export type Grant = {
  id: string; user_id: string; source: GrantSource; plan_id: string | null; plan_name: string;
  starts_at: Date; ends_at: Date | null; quota_bytes: string | null; used_bytes: string; device_limit: number | null;
  reference: string | null; status: "active" | "revoked"; note: string; created_by: string | null; created_at: Date; revoked_at: Date | null;
};

export type Plan = {
  id: string; name: string; duration_days: number | null; quota_bytes: string | null; device_limit: number | null;
  is_welcome: boolean; enabled: boolean; sort_order: number;
};

export class EntitlementError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** The single access rule, as SQL over a users row aliased `alias`. */
export function accessSql(alias = "u"): string {
  return `(${alias}.status='active' AND ${alias}.access_ok AND (${alias}.access_until IS NULL OR ${alias}.access_until>now()))`;
}

const num = (value: string | number | null) => value === null ? null : Number(value);
const exhausted = (grant: Grant) => grant.quota_bytes !== null && Number(grant.used_bytes) >= Number(grant.quota_bytes);
const live = (grant: Grant, at: number) => grant.status === "active" && !exhausted(grant) && (grant.ends_at === null || grant.ends_at.getTime() > at);
const usable = (grant: Grant, at: number) => live(grant, at) && grant.starts_at.getTime() <= at;

/** Whether the account may connect now, and until when coverage runs without a gap (null = no end). */
export function evaluate(grants: Grant[], at = Date.now()) {
  const current = grants.filter((grant) => usable(grant, at));
  let until: number | null = at;
  let cursor = at;
  // Follow back-to-back grants (a renewal starts where the last one ends) to the first gap.
  for (;;) {
    const covering = grants.filter((grant) => live(grant, at) && grant.starts_at.getTime() <= cursor && (grant.ends_at === null || grant.ends_at.getTime() > cursor));
    if (!covering.length) break;
    if (covering.some((grant) => grant.ends_at === null)) { until = null; break; }
    cursor = Math.max(...covering.map((grant) => grant.ends_at!.getTime()));
    until = cursor;
  }
  const limits = current.map((grant) => grant.device_limit).filter((value): value is number => value !== null);
  return { ok: current.length > 0, until: current.length ? until : null, deviceLimit: limits.length ? Math.max(...limits) : null, current };
}

/** What people see: state, end date and the traffic of the grants in force now. */
export function describe(grants: Grant[], at = Date.now()) {
  const { ok, until, deviceLimit, current } = evaluate(grants, at);
  const active = grants.filter((grant) => grant.status === "active");
  const state: AccessState = ok ? "active"
    : active.some((grant) => exhausted(grant) && grant.starts_at.getTime() <= at && (grant.ends_at === null || grant.ends_at.getTime() > at)) ? "exhausted"
      : active.length ? "expired" : "none";
  // Traffic of the grants in force; once they are used up, of the used-up ones still in their window.
  const counted = ok ? current : active.filter((grant) => grant.starts_at.getTime() <= at && (grant.ends_at === null || grant.ends_at.getTime() > at));
  const metered = counted.length > 0 && counted.every((grant) => grant.quota_bytes !== null);
  const quotaBytes = metered ? counted.reduce((sum, grant) => sum + Number(grant.quota_bytes), 0) : null;
  const usedBytes = metered ? counted.reduce((sum, grant) => sum + Number(grant.used_bytes), 0) : 0;
  const lastEnd = active.map((grant) => grant.ends_at?.getTime() || 0).filter((value) => value && value <= at).sort((a, b) => b - a)[0];
  return {
    state, until: until === null ? null : new Date(until).toISOString(),
    endedAt: !ok && lastEnd ? new Date(lastEnd).toISOString() : null,
    quotaBytes, usedBytes, remainingBytes: quotaBytes === null ? null : Math.max(0, quotaBytes - usedBytes),
    deviceLimit,
    upcoming: active.filter((grant) => grant.starts_at.getTime() > at && live(grant, at)).length,
  };
}

export function publicGrant(grant: Grant, at = Date.now()) {
  const state = grant.status === "revoked" ? "revoked" : exhausted(grant) ? "exhausted"
    : grant.ends_at && grant.ends_at.getTime() <= at ? "expired" : grant.starts_at.getTime() > at ? "upcoming" : "active";
  return {
    id: grant.id, source: grant.source, planId: grant.plan_id, planName: grant.plan_name, state,
    startsAt: grant.starts_at.toISOString(), endsAt: grant.ends_at?.toISOString() || null,
    quotaBytes: num(grant.quota_bytes), usedBytes: Number(grant.used_bytes), deviceLimit: grant.device_limit,
    reference: grant.reference, note: grant.note, createdAt: grant.created_at.toISOString(), revokedAt: grant.revoked_at?.toISOString() || null,
  };
}

export function publicPlan(plan: Plan) {
  return { id: plan.id, name: plan.name, durationDays: plan.duration_days, quotaBytes: num(plan.quota_bytes), deviceLimit: plan.device_limit,
    isWelcome: plan.is_welcome, enabled: plan.enabled, sortOrder: plan.sort_order };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  await dbQuery("SELECT 1");
  const client = await getDb().connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function lockedGrants(client: PoolClient, userId: string): Promise<Grant[]> {
  if (!(await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId])).rowCount) throw new EntitlementError("账号不存在", 404);
  return (await client.query<Grant>("SELECT * FROM access_grants WHERE user_id=$1 ORDER BY starts_at, created_at", [userId])).rows;
}

/** Writes the cache from the grants; returns whether access flipped. */
async function store(client: PoolClient, userId: string, grants: Grant[]) {
  const before = (await client.query<{ ok: boolean }>(`SELECT ${accessSql("users")} AS ok FROM users WHERE id=$1`, [userId])).rows[0]?.ok;
  const { ok, until, deviceLimit } = evaluate(grants);
  await client.query("UPDATE users SET access_ok=$2,access_until=$3,access_device_limit=$4 WHERE id=$1", [userId, ok, until === null ? null : new Date(until), deviceLimit]);
  const after = (await client.query<{ ok: boolean }>(`SELECT ${accessSql("users")} AS ok FROM users WHERE id=$1`, [userId])).rows[0]?.ok;
  return before !== after;
}

export async function userGrants(userId: string) {
  return dbQuery<Grant>("SELECT * FROM access_grants WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
}

export async function accountAccess(userId: string) {
  return describe(await userGrants(userId));
}

export type GrantInput = {
  planId?: string | null;
  /** Without a plan: days of validity, an end date, or neither for no end. */
  days?: number | null; endsAt?: string | null; quotaBytes?: number | null; deviceLimit?: number | null;
  source: GrantSource; reference?: string | null; note?: string; actorId?: string | null;
};

/**
 * The only way to give an account time or traffic: Console, the welcome gift and future payment
 * callbacks all come here. A timed grant starts where the account's current timed coverage ends,
 * so renewals stack; anything else starts now. A repeated `reference` returns the earlier grant.
 */
export async function grantAccess(userId: string, input: GrantInput) {
  if (input.reference) {
    const existing = (await dbQuery<Grant>("SELECT * FROM access_grants WHERE reference=$1", [input.reference]))[0];
    if (existing) return { grant: existing, changed: false };
  }
  const plan = input.planId ? (await dbQuery<Plan>("SELECT * FROM access_plans WHERE id=$1", [input.planId]))[0] : undefined;
  if (input.planId && (!plan || (!plan.enabled && input.source !== "welcome"))) throw new EntitlementError("套餐不存在或已停用");
  const days = plan ? plan.duration_days : input.days ?? null;
  const quota = plan ? num(plan.quota_bytes) : input.quotaBytes ?? null;
  const deviceLimit = plan ? plan.device_limit : input.deviceLimit ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new EntitlementError("有效天数应为 1–3650");
  if (quota !== null && (!Number.isSafeInteger(quota) || quota <= 0)) throw new EntitlementError("流量额度应大于 0");
  if (deviceLimit !== null && (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 100)) throw new EntitlementError("设备上限应为 1–100");
  const endsAt = !plan && input.endsAt ? new Date(input.endsAt) : null;
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= Date.now())) throw new EntitlementError("到期时间必须晚于现在");
  const result = await inTransaction(async (client) => {
    const grants = await lockedGrants(client, userId);
    const now = Date.now();
    const timedEnd = Math.max(now, ...grants.filter((grant) => live(grant, now) && grant.ends_at).map((grant) => grant.ends_at!.getTime()));
    const startsAt = days !== null ? new Date(timedEnd) : new Date(now);
    const end = days !== null ? new Date(startsAt.getTime() + days * 86_400_000) : endsAt;
    const grant = (await client.query<Grant>(`INSERT INTO access_grants (id,user_id,source,plan_id,plan_name,starts_at,ends_at,quota_bytes,device_limit,reference,note,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [`grant_${randomUUID()}`, userId, input.source, plan?.id || null, plan?.name || "", startsAt, end, quota, deviceLimit, input.reference || null,
      (input.note || "").slice(0, 200), input.actorId || null])).rows[0];
    const changed = await store(client, userId, [...grants, grant]);
    return { grant, changed };
  });
  await addAudit({ actorUserId: input.actorId || userId, action: "account.access_granted", targetType: "user", targetId: userId,
    metadata: { grantId: result.grant.id, source: input.source, planId: plan?.id || null, days, quotaBytes: quota, endsAt: result.grant.ends_at, reference: input.reference || null } });
  return result;
}

export async function revokeGrant(userId: string, grantId: string, actorId: string) {
  const changed = await inTransaction(async (client) => {
    const grants = await lockedGrants(client, userId);
    const grant = grants.find((item) => item.id === grantId);
    if (!grant) throw new EntitlementError("权益记录不存在", 404);
    if (grant.status === "revoked") return false;
    grant.status = "revoked";
    await client.query("UPDATE access_grants SET status='revoked',revoked_at=now() WHERE id=$1", [grantId]);
    // Later timed grants were stacked behind this one; pull them forward so no paid time is lost.
    const length = grant.ends_at ? grant.ends_at.getTime() - Math.max(Date.now(), grant.starts_at.getTime()) : 0;
    if (length > 0) {
      for (const later of grants.filter((item) => item.status === "active" && item.ends_at && item.starts_at.getTime() >= grant.ends_at!.getTime())) {
        later.starts_at = new Date(later.starts_at.getTime() - length); later.ends_at = new Date(later.ends_at!.getTime() - length);
        await client.query("UPDATE access_grants SET starts_at=$2,ends_at=$3 WHERE id=$1", [later.id, later.starts_at, later.ends_at]);
      }
    }
    return store(client, userId, grants);
  });
  await addAudit({ actorUserId: actorId, action: "account.access_revoked", targetType: "user", targetId: userId, metadata: { grantId } });
  return changed;
}

/** Recomputes the cache from the grants (for example after an end date passed). */
export async function refreshAccess(userId: string) {
  return inTransaction(async (client) => store(client, userId, await lockedGrants(client, userId)));
}

/** New accounts get the plan marked as the welcome gift, if any. */
export async function grantWelcome(userId: string) {
  const plan = (await dbQuery<Plan>("SELECT * FROM access_plans WHERE is_welcome"))[0];
  if (plan) await grantAccess(userId, { planId: plan.id, source: "welcome", reference: `welcome:${userId}` });
  else await refreshAccess(userId);
}

/**
 * Counts traffic against the grants in force: unlimited grants absorb everything, otherwise the one
 * ending soonest pays first. Returns the accounts whose access just ended so nodes drop them.
 */
export async function chargeTraffic(bytesByUser: Map<string, number>): Promise<string[]> {
  const ended: string[] = [];
  for (const [userId, bytes] of bytesByUser) {
    if (!(bytes > 0)) continue;
    const flipped = await inTransaction(async (client) => {
      const grants = await lockedGrants(client, userId);
      const now = Date.now();
      const order = grants.filter((grant) => usable(grant, now)).sort((a, b) =>
        Number(a.quota_bytes !== null) - Number(b.quota_bytes !== null) || (a.ends_at?.getTime() ?? Infinity) - (b.ends_at?.getTime() ?? Infinity) || a.created_at.getTime() - b.created_at.getTime());
      if (!order.length) return false;
      let left = bytes;
      for (const grant of order) {
        const take = grant.quota_bytes === null ? left : Math.min(left, Number(grant.quota_bytes) - Number(grant.used_bytes));
        if (take <= 0) continue;
        grant.used_bytes = String(Number(grant.used_bytes) + take); left -= take;
        if (!left) break;
      }
      // Traffic after the last byte of quota still happened; it stays on the last grant.
      if (left > 0) order[order.length - 1].used_bytes = String(Number(order[order.length - 1].used_bytes) + left);
      for (const grant of order) await client.query("UPDATE access_grants SET used_bytes=$2 WHERE id=$1 AND used_bytes<>$2", [grant.id, grant.used_bytes]);
      return store(client, userId, grants);
    });
    if (flipped) ended.push(userId);
  }
  return ended;
}

/** Access of every account at once, for the Console account list. */
export async function accessByUser() {
  const grants = await dbQuery<Grant>("SELECT * FROM access_grants ORDER BY created_at");
  const byUser = new Map<string, Grant[]>();
  for (const grant of grants) byUser.set(grant.user_id, [...(byUser.get(grant.user_id) || []), grant]);
  return new Map([...byUser].map(([userId, items]) => [userId, describe(items)]));
}

export async function listPlans() {
  return (await dbQuery<Plan>("SELECT * FROM access_plans ORDER BY sort_order, created_at")).map(publicPlan);
}

export type PlanInput = { name: unknown; durationDays: unknown; quotaBytes: unknown; deviceLimit: unknown; enabled: unknown; isWelcome: unknown };

/** Creates (no id) or updates a plan. Grants already given keep their own copy of the terms. */
export async function savePlan(id: string | null, input: PlanInput, actorId: string) {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  const optional = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
  const durationDays = optional(input.durationDays), quotaBytes = optional(input.quotaBytes), deviceLimit = optional(input.deviceLimit);
  if (!name) throw new EntitlementError("请填写套餐名称");
  if (durationDays !== null && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650)) throw new EntitlementError("有效天数应为 1–3650");
  if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0)) throw new EntitlementError("流量额度应大于 0");
  if (deviceLimit !== null && (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 100)) throw new EntitlementError("设备上限应为 1–100");
  const enabled = input.enabled !== false, isWelcome = input.isWelcome === true && enabled;
  const planId = await inTransaction(async (client) => {
    if (isWelcome) await client.query("UPDATE access_plans SET is_welcome=FALSE WHERE is_welcome AND id<>$1", [id || ""]);
    if (id) {
      const updated = await client.query("UPDATE access_plans SET name=$2,duration_days=$3,quota_bytes=$4,device_limit=$5,enabled=$6,is_welcome=$7,updated_at=now() WHERE id=$1",
        [id, name, durationDays, quotaBytes, deviceLimit, enabled, isWelcome]);
      if (!updated.rowCount) throw new EntitlementError("套餐不存在", 404);
      return id;
    }
    const created = `plan_${randomUUID().slice(0, 8)}`;
    await client.query(`INSERT INTO access_plans (id,name,duration_days,quota_bytes,device_limit,enabled,is_welcome,sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(sort_order),0)+1 FROM access_plans))`, [created, name, durationDays, quotaBytes, deviceLimit, enabled, isWelcome]);
    return created;
  });
  await addAudit({ actorUserId: actorId, action: id ? "plan.updated" : "plan.created", targetType: "plan", targetId: planId, metadata: { name, durationDays, quotaBytes, deviceLimit, enabled, isWelcome } });
  return listPlans();
}
