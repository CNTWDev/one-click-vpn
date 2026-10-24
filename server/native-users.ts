import { dbQuery } from "./db";
import { accessSql } from "./entitlements";

/**
 * App devices currently allowed to connect: active enrollment and an account with access (entitlements.ts).
 * The same rule as native WireGuard leases, without the per-node lease. `email` is the device's
 * telemetry identity on nodes: the UUID part of its enrollment id, never its secret.
 */
export async function nativeUserRows() {
  if (process.env.VEILBIRD_NATIVE_ACCESS_ENABLED === "0") return [];
  return dbQuery<{ secret_id: string; email: string; fingerprint: string }>(`SELECT DISTINCT ON (e.id) s.id AS secret_id, substring(e.id from 5) AS email, s.fingerprint
    FROM native_enrollments e JOIN users u ON u.id=e.user_id
    JOIN secret_materials s ON s.kind='native_secret:' || e.id AND s.owner_node_id IS NULL
    WHERE e.status='active' AND ${accessSql()}
    ORDER BY e.id, s.created_at`);
}
