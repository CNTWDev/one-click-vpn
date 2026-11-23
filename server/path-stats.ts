import { dbExec, dbQuery } from "./db";
import { cohortOf, readyGeo, type Cohort } from "./geo";
import { appTransports } from "./app-transports";
import { parseProbeDetail, type ProbeResult } from "./path-probe";

export { parseProbeDetail };

/**
 * How each node's transports do from each country and network (ASN), per UTC day, kept 14 days: the data the
 * recommended node order is built from. Fed by the apps' probe summaries (TRANSPORT_PROBE), labelled with the
 * country and ASN of the address the report came from; the address itself is not kept. Reports with no
 * known country (private address, no database yet) are skipped.
 */

export async function recordPathProbe(nodeId: string, cohort: Cohort, results: ProbeResult[]): Promise<void> {
  for (const result of results) {
    await dbExec(`INSERT INTO node_path_stats (node_id, transport, country, asn, day, attempts, successes, delay_sum_ms, delay_count)
      SELECT $1, $2, $3, $4, (now() AT TIME ZONE 'UTC')::date, 1, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM nodes WHERE id = $1)
      ON CONFLICT (node_id, transport, country, asn, day) DO UPDATE SET attempts = node_path_stats.attempts + 1,
        successes = node_path_stats.successes + EXCLUDED.successes, delay_sum_ms = node_path_stats.delay_sum_ms + EXCLUDED.delay_sum_ms,
        delay_count = node_path_stats.delay_count + EXCLUDED.delay_count`,
    [nodeId, result.transport, cohort.country, cohort.asn, result.ok ? 1 : 0, result.delayMs ?? 0, result.delayMs === null ? 0 : 1]);
  }
}

let lastPrune = 0;

/** One app report: looked up, counted, and the address forgotten. */
export async function recordProbeFromAddress(nodeId: string, address: string, detail: string | null | undefined, now = Date.now()): Promise<Cohort | null> {
  const results = parseProbeDetail(detail, appTransports);
  if (!results.length) return null;
  await readyGeo(2000, now);
  const cohort = cohortOf(address);
  if (!cohort) return null;
  await recordPathProbe(nodeId, cohort, results);
  if (now - lastPrune > 3600_000) {
    lastPrune = now;
    await dbExec("DELETE FROM node_path_stats WHERE day < (now() AT TIME ZONE 'UTC')::date - 14");
  }
  return cohort;
}

export type PathStat = { nodeId: string; transport: string; country: string; asn: number; attempts: number; successes: number; delayMs: number | null };

/** Totals over the last `days` days for one country (and ASN when given), for the recommended order and the Console. */
export async function pathStats(country: string, asn: number | null, days = 7): Promise<PathStat[]> {
  const rows = await dbQuery<{ node_id: string; transport: string; country: string; asn: number; attempts: string; successes: string; delay_sum: string; delay_count: string }>(
    `SELECT node_id, transport, country, asn, sum(attempts) AS attempts, sum(successes) AS successes, sum(delay_sum_ms) AS delay_sum, sum(delay_count) AS delay_count
     FROM node_path_stats WHERE country = $1 AND ($2::int IS NULL OR asn = $2) AND day >= (now() AT TIME ZONE 'UTC')::date - $3::int
     GROUP BY node_id, transport, country, asn`, [country, asn, days]);
  return rows.map((row) => ({ nodeId: row.node_id, transport: row.transport, country: row.country, asn: Number(row.asn), attempts: Number(row.attempts),
    successes: Number(row.successes), delayMs: Number(row.delay_count) ? Math.round(Number(row.delay_sum) / Number(row.delay_count)) : null }));
}
