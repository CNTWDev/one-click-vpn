import { dbExec, dbQuery } from "./db";
import { runAccessJobs } from "./access-jobs";
import { expireDueConnectionProfiles } from "./control-db";
import { markAccessChanged } from "./reconcile-schedule";
import { writeOperationalLog } from "./operational-logs";
import { runAlerts } from "./alerts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let lastBoundaryCheck = new Date(Date.now() - 10 * MINUTE);

/**
 * Once a minute: account periods, profile expiry and Agent task retries. Any access boundary that passed
 * since the last run marks every node due for a rebuild on its next heartbeat (server/reconcile-schedule.ts).
 */
export async function runMinuteJobs(): Promise<void> {
  const until = new Date();
  const refreshed = await runAccessJobs();
  const expired = await expireDueConnectionProfiles();
  const boundary = (await dbQuery<{ passed: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM users WHERE access_until > $1 AND access_until <= $2)
      OR EXISTS (SELECT 1 FROM access_grants WHERE status = 'active' AND ((starts_at > $1 AND starts_at <= $2) OR (ends_at > $1 AND ends_at <= $2)))
      OR EXISTS (SELECT 1 FROM native_leases WHERE expires_at > $1 AND expires_at <= $2)
      OR EXISTS (SELECT 1 FROM access_credentials WHERE status = 'active' AND expires_at > $3 AND expires_at <= $4) AS passed`,
  [lastBoundaryCheck, until, lastBoundaryCheck.toISOString(), until.toISOString()]))[0]?.passed;
  lastBoundaryCheck = until;
  if (refreshed || expired || boundary) markAccessChanged();
  await retryReconcileTasks();
  await runAlerts().catch((error) => console.error("Alerts failed", error instanceof Error ? error.message : error));
}

/** Tasks an Agent took but never reported return to the queue; failed ones retry up to five times. */
async function retryReconcileTasks(): Promise<void> {
  const now = Date.now();
  await dbExec("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE status = 'running' AND started_at < $1",
    [new Date(now - 5 * MINUTE).toISOString()]);
  await dbExec("UPDATE reconcile_tasks SET status = 'pending', started_at = NULL WHERE status = 'failed' AND attempts < 5 AND finished_at < $1",
    [new Date(now - 30_000).toISOString()]);
}

/**
 * Once a day: drop rows nothing reads any more. Finished Agent tasks carry a full copy of the node's
 * configuration, so they are kept a week (plus the latest per node and protocol, which the node page shows).
 */
export async function runDailyJobs(): Promise<Record<string, number>> {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const removed = {
    reconcileTasks: await dbExec(`DELETE FROM reconcile_tasks t WHERE t.status IN ('succeeded', 'failed') AND t.finished_at < $1
      AND (t.status = 'succeeded' OR t.attempts >= 5)
      AND t.id <> (SELECT x.id FROM reconcile_tasks x WHERE x.node_id = t.node_id AND x.protocol = t.protocol
        AND x.status IN ('succeeded', 'failed') ORDER BY x.finished_at DESC NULLS LAST LIMIT 1)`, [ago(7 * DAY)]),
    // OpenVPN keeps one row per connection; once it is closed only its traffic (already in traffic_daily) mattered.
    closedSessions: await dbExec("DELETE FROM traffic_counters WHERE protocol = 'openvpn' AND connected = 0 AND observed_at < $1", [ago(DAY)]),
    // Identities a node stopped reporting a month ago are gone from it; a new peer starts its counters at zero.
    staleCounters: await dbExec("DELETE FROM traffic_counters WHERE observed_at < $1", [ago(30 * DAY)]),
    nodeActions: await dbExec(`DELETE FROM node_actions a WHERE a.status NOT IN ('queued', 'running') AND a.created_at < $1
      AND a.id NOT IN (SELECT x.id FROM node_actions x WHERE x.node_id = a.node_id ORDER BY x.created_at DESC LIMIT 20)`, [ago(30 * DAY)]),
    auditLogs: await dbExec("DELETE FROM audit_logs WHERE created_at < $1", [ago(180 * DAY)]),
    joinTokens: await dbExec("DELETE FROM node_join_tokens WHERE expires_at < $1", [ago(DAY)]),
    deviceSessions: await dbExec("DELETE FROM device_sessions WHERE refresh_expires_at < $1 OR revoked_at < $1", [ago(DAY)]),
  };
  if (Object.values(removed).some(Boolean)) {
    await writeOperationalLog({ component: "controller", level: "info", message: "maintenance.pruned", action: "maintenance.pruned", fields: removed })
      .catch(() => undefined);
  }
  return removed;
}

let started = false;
/** Starts the minute and daily loops once per server process. */
export function startBackgroundJobs(): void {
  if (started) return;
  started = true;
  let minuteRunning = false;
  const minute = () => {
    if (minuteRunning) return;
    minuteRunning = true;
    void runMinuteJobs().catch((error) => console.error("Minute jobs failed", error)).finally(() => { minuteRunning = false; });
  };
  const daily = () => { void runDailyJobs().catch((error) => console.error("Daily maintenance failed", error)); };
  setTimeout(minute, 15_000).unref();
  setInterval(minute, MINUTE).unref();
  setTimeout(daily, 5 * MINUTE).unref();
  setInterval(daily, DAY).unref();
}
