import { dbQuery, type DbUser } from "./db";
import { publicUser } from "./device-auth";
import { accessByUser, accessSql } from "./entitlements";
import { adminUserAccessSummaries, recentUsageWindow } from "./traffic";

/**
 * Console → 账号管理: one page of accounts, filtered, searched and sorted in PostgreSQL, so the list stays
 * fast with tens of thousands of accounts. Access and usage are worked out for the accounts on that page only.
 */

export const USER_FILTERS = ["all", "pending", "active", "suspended", "rejected", "ending", "ended"] as const;
export const USER_SORTS = ["created", "name", "until", "traffic", "activity"] as const;
export type UserFilter = typeof USER_FILTERS[number];
export type UserSort = typeof USER_SORTS[number];
export const USER_PAGE_DEFAULT = 50;
export const USER_PAGE_MAX = 200;

/** Same thresholds as the Console's access summary (account-access.tsx): 7 days left, or 10% of the data left. */
const SOON_DAYS = 7;
const LOW_SHARE = 0.1;

// Accounts whose grants in force are all metered and nearly used up: the grants describe() counts.
const lowDataSql = `SELECT g.user_id FROM access_grants g
  WHERE g.status = 'active' AND g.starts_at <= now() AND (g.ends_at IS NULL OR g.ends_at > now()) AND (g.quota_bytes IS NULL OR g.used_bytes < g.quota_bytes)
  GROUP BY g.user_id HAVING bool_and(g.quota_bytes IS NOT NULL) AND SUM(g.quota_bytes) - SUM(g.used_bytes) <= SUM(g.quota_bytes) * ${LOW_SHARE}`;
const filterSql: Record<UserFilter, string> = {
  all: "TRUE", pending: "u.status = 'pending'", active: "u.status = 'active'", suspended: "u.status = 'suspended'", rejected: "u.status = 'rejected'",
  ending: `(u.status = 'active' AND ${accessSql("u")} AND (u.access_until <= now() + make_interval(days => ${SOON_DAYS}) OR u.id IN (SELECT user_id FROM low_data)))`,
  ended: `(u.status = 'active' AND NOT ${accessSql("u")})`,
};

/** ORDER BY per sort, with `id` last so rows that tie never repeat or go missing between pages. */
const orderSql: Record<UserSort, string> = {
  created: "u.created_at DESC, u.id DESC",
  name: "lower(u.display_name), u.id",
  // Accounts without access first (they need attention), then the soonest end, unlimited last.
  until: "CASE WHEN u.access_ok AND (u.access_until IS NULL OR u.access_until > now()) THEN COALESCE(u.access_until, 'infinity'::timestamptz) ELSE '-infinity'::timestamptz END, u.id",
  traffic: "COALESCE(usage.total_bytes, 0) DESC, u.created_at DESC, u.id DESC",
  activity: "activity.last_activity_at DESC NULLS LAST, u.created_at DESC, u.id DESC",
};

export type UserListQuery = { filter: UserFilter; sort: UserSort; q: string; offset: number; limit: number };

export function parseUserListQuery(params: URLSearchParams): UserListQuery {
  // `status` is the older name of the status filters.
  const filter = params.get("filter") || params.get("status") || "";
  const sort = params.get("sort") || "";
  const whole = (value: string | null, fallback: number) => /^\d{1,9}$/.test(value || "") ? Number(value) : fallback;
  return {
    filter: (USER_FILTERS as readonly string[]).includes(filter) ? filter as UserFilter : "all",
    sort: (USER_SORTS as readonly string[]).includes(sort) ? sort as UserSort : "created",
    q: (params.get("q") || "").trim().slice(0, 200),
    offset: whole(params.get("offset"), 0),
    limit: Math.min(Math.max(whole(params.get("limit"), USER_PAGE_DEFAULT), 1), USER_PAGE_MAX),
  };
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** How many accounts each filter chip holds, over all accounts (search does not change the chips). */
export async function countUsersByFilter(): Promise<Record<UserFilter, number>> {
  const row = (await dbQuery<Record<UserFilter, number>>(`WITH low_data AS (${lowDataSql})
    SELECT ${USER_FILTERS.map((filter) => `COUNT(*) FILTER (WHERE ${filterSql[filter]})::int AS "${filter}"`).join(", ")} FROM users u`))[0];
  return Object.fromEntries(USER_FILTERS.map((filter) => [filter, Number(row?.[filter] || 0)])) as Record<UserFilter, number>;
}

export async function listAdminUsers(query: UserListQuery) {
  const values: unknown[] = [];
  const where = [filterSql[query.filter]];
  if (query.q) { values.push(likePattern(query.q)); where.push(`(u.display_name ILIKE $1 OR u.email ILIKE $1)`); }
  const filterValues = values.length;
  const joins: string[] = [];
  if (query.sort === "traffic") {
    const { from, to } = recentUsageWindow();
    values.push(from, to);
    joins.push(`LEFT JOIN (SELECT t.user_id, SUM(t.upload_bytes + t.download_bytes) AS total_bytes FROM traffic_daily t
      WHERE t.day BETWEEN $${values.length - 1} AND $${values.length} GROUP BY t.user_id) usage ON usage.user_id = u.id`);
  }
  if (query.sort === "activity") joins.push(`LEFT JOIN (SELECT d.user_id, MAX(c.last_handshake_at) AS last_activity_at FROM traffic_counters c
      INNER JOIN devices d ON d.id = c.device_id GROUP BY d.user_id) activity ON activity.user_id = u.id`);
  values.push(query.limit, query.offset);
  const rows = await dbQuery<DbUser & { total: number }>(`WITH low_data AS (${lowDataSql})
    SELECT u.id, u.email, u.display_name, u.role, u.status, u.approved_at, u.approved_by, u.rejection_reason, u.created_at, u.updated_at,
      COUNT(*) OVER ()::int AS total
    FROM users u ${joins.join(" ")}
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderSql[query.sort]} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  // Past the last page no row carries the total, so count it on its own.
  const total = rows.length ? Number(rows[0].total) : !query.offset ? 0 : Number((await dbQuery<{ total: number }>(`WITH low_data AS (${lowDataSql})
    SELECT COUNT(*)::int AS total FROM users u WHERE ${where.join(" AND ")}`, values.slice(0, filterValues)))[0]?.total || 0);
  const ids = rows.map((row) => row.id);
  const [summaries, access] = await Promise.all([adminUserAccessSummaries(ids), accessByUser(ids)]);
  return {
    total,
    users: rows.map((row) => ({ ...publicUser(row), access: access.get(row.id) || null, accessSummary: summaries.get(row.id) || {
      deviceCount: 0, activeDeviceCount: 0, credentialCount: 0, activeCredentialCount: 0, profileCount: 0, activeProfileCount: 0,
      certificateCount: 0, activeCertificateCount: 0, uploadBytes: 0, downloadBytes: 0, totalBytes: 0, lastActivityAt: null,
    } })),
  };
}
