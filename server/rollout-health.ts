import type { ClientPlatform } from "../shared/client-releases";

/**
 * Staged-rollout health: how a build in rollout compares with the stable build it replaces, on the same
 * platform and over the same 24 hours. Everything is read from Loki (the apps' CONNECT_SESSION, APP_CRASH and
 * other diagnostics, written by native-clients.ts); nothing about it is stored in Postgres.
 *
 * Four metrics decide (crash rate, connect success, time to connect P90, unexpected disconnects per connected
 * hour); protocol fallback is shown only. A metric is judged only once both builds have enough data.
 */

export type MetricKey = "crash" | "success" | "connectP90" | "drops";
export type Verdict = "ok" | "better" | "bad" | "insufficient";
export type BuildFigures = {
  users: number; sessions: number; crashUsers: number; okSessions: number; failedSessions: number;
  connectP50: number | null; connectP90: number | null; drops: number; connectedSeconds: number; fallbackSessions: number;
};
export type MetricResult = { key: MetricKey; current: number | null; baseline: number | null; verdict: Verdict; trend: Array<number | null> };
export type BuildHealth = {
  platform: ClientPlatform; build: number; baselineBuild: number | null; verdict: Verdict;
  figures: BuildFigures; baselineFigures: BuildFigures | null; metrics: MetricResult[];
  fallbackRate: number | null; baselineFallbackRate: number | null;
  /** The same crash on 3 or more installs within the last hour: stop at once, whatever the sample. */
  crashBurst: { signature: string; users: number } | null;
  reasons: string[];
};

/** Defaults agreed in the stability plan (2026-11-23); PR 2 makes them editable in Console. */
export const thresholds = {
  minUsers: 30, minSessions: 200,
  crashRatio: 1.5, crashCeiling: 0.01,
  successDropPoints: 2, successFloor: 0.7,
  connectRatio: 1.3, connectExtraMs: 2000,
  dropsRatio: 1.5,
  burstUsers: 3,
};

const empty = (): BuildFigures => ({ users: 0, sessions: 0, crashUsers: 0, okSessions: 0, failedSessions: 0, connectP50: null, connectP90: null, drops: 0, connectedSeconds: 0, fallbackSessions: 0 });

const ratio = (part: number, whole: number) => whole > 0 ? part / whole : null;
export const crashRate = (f: BuildFigures) => ratio(f.crashUsers, f.users);
/** Sessions the user cancelled before they connected say nothing about the build. */
export const successRate = (f: BuildFigures) => ratio(f.okSessions, f.okSessions + f.failedSessions);
export const dropsPerHour = (f: BuildFigures) => ratio(f.drops, f.connectedSeconds / 3600);
const fallbackRate = (f: BuildFigures) => ratio(f.fallbackSessions, f.okSessions);

const enough = (f: BuildFigures) => f.users >= thresholds.minUsers && f.sessions >= thresholds.minSessions;

/** One metric: "bad" past its limit, "better" clearly ahead of stable, else "ok"; "insufficient" until both builds have data. */
export function judge(key: MetricKey, current: BuildFigures, baseline: BuildFigures | null): Verdict {
  if (!baseline || !enough(current) || !enough(baseline)) return "insufficient";
  if (key === "crash") {
    const now = crashRate(current) ?? 0, before = crashRate(baseline) ?? 0;
    if (now > thresholds.crashCeiling || now > Math.max(before * thresholds.crashRatio, 0.001)) return "bad";
    return now < before * 0.8 ? "better" : "ok";
  }
  if (key === "success") {
    const now = successRate(current), before = successRate(baseline);
    if (now === null || before === null) return "insufficient";
    if (now < before - thresholds.successDropPoints / 100) return "bad";
    return now > before + 0.01 ? "better" : "ok";
  }
  if (key === "connectP90") {
    const now = current.connectP90, before = baseline.connectP90;
    if (now === null || before === null) return "insufficient";
    if (now > before * thresholds.connectRatio && now - before > thresholds.connectExtraMs) return "bad";
    return now < before * 0.85 ? "better" : "ok";
  }
  const now = dropsPerHour(current), before = dropsPerHour(baseline);
  if (now === null || before === null) return "insufficient";
  // A tiny stable figure would make any single drop look like a regression: compare against at least 0.02/h.
  if (now > Math.max(before, 0.02) * thresholds.dropsRatio) return "bad";
  return now < before * 0.8 ? "better" : "ok";
}

function metricValue(key: MetricKey, f: BuildFigures): number | null {
  if (key === "crash") return crashRate(f);
  if (key === "success") return successRate(f);
  if (key === "connectP90") return f.connectP90;
  return dropsPerHour(f);
}

/** Hard stops that do not wait for a full sample. */
export function hardStops(current: BuildFigures, crashBurst: BuildHealth["crashBurst"]): string[] {
  const reasons: string[] = [];
  if (crashBurst && crashBurst.users >= thresholds.burstUsers) reasons.push("crash-burst");
  const success = successRate(current);
  if (success !== null && current.okSessions + current.failedSessions >= 20 && success < thresholds.successFloor) reasons.push("success-floor");
  return reasons;
}

// ---- Loki --------------------------------------------------------------------------------------------------------

type Vector = Array<{ metric: Record<string, string>; value: [number, string] }>;
type Matrix = Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;

const lokiUrl = () => process.env.VEILBIRD_LOKI_URL?.trim().replace(/\/$/, "") || null;
const platformLabel = (platform: ClientPlatform) => platform.replace(/[^a-z]/g, "");
const events = (platform: ClientPlatform, event: string, extra = "") =>
  `{service="northstar",component="client"} |= "${event}" | json | event="${event}" | platform="${platformLabel(platform)}"${extra}`;

async function instant(query: string): Promise<Vector> {
  const url = lokiUrl();
  if (!url) return [];
  const params = new URLSearchParams({ query, time: String(Date.now() * 1_000_000) });
  const response = await fetch(`${url}/loki/api/v1/query?${params}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Loki ${response.status}`);
  return ((await response.json()) as { data?: { result?: Vector } }).data?.result || [];
}

/** Daily points for the last 7 days (each the 24 hours up to that point), oldest first. */
async function daily(query: string): Promise<Matrix> {
  const url = lokiUrl();
  if (!url) return [];
  const end = Date.now(), start = end - 6 * 86400_000;
  const params = new URLSearchParams({ query, start: String(start * 1_000_000), end: String(end * 1_000_000), step: "86400" });
  const response = await fetch(`${url}/loki/api/v1/query_range?${params}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Loki ${response.status}`);
  return ((await response.json()) as { data?: { result?: Matrix } }).data?.result || [];
}

const byBuild = (rows: Vector, read: (row: Vector[number]) => number = (row) => Number(row.value[1]) || 0) => {
  const map = new Map<number, number>();
  for (const row of rows) { const build = Number(row.metric.build); if (Number.isFinite(build)) map.set(build, (map.get(build) || 0) + read(row)); }
  return map;
};

/** The LogQL each figure comes from, for the window given (24h for verdicts, 1h for the crash burst). */
export function queries(platform: ClientPlatform, window = "24h") {
  const session = (extra = "") => events(platform, "client.session", extra);
  const anyEvent = `{service="northstar",component="client"} | json | event=~"client.session|client.crash|client.diagnostic" | platform="${platformLabel(platform)}"`;
  return {
    users: `count by (build) (sum by (build, actor_id) (count_over_time(${anyEvent} [${window}])))`,
    crashUsers: `count by (build) (sum by (build, actor_id) (count_over_time(${events(platform, "client.crash")} [${window}])))`,
    sessions: `sum by (build, outcome) (count_over_time(${session()} [${window}]))`,
    p50: `quantile_over_time(0.5, ${session(` | outcome="ok" | unwrap ms`)} [${window}]) by (build)`,
    p90: `quantile_over_time(0.9, ${session(` | outcome="ok" | unwrap ms`)} [${window}]) by (build)`,
    drops: `sum by (build) (sum_over_time(${session(" | unwrap drops")} [${window}]))`,
    seconds: `sum by (build) (sum_over_time(${session(" | unwrap seconds")} [${window}]))`,
    fallbacks: `sum by (build) (count_over_time(${session(` | outcome="ok" | fallbacks > 0`)} [${window}]))`,
    burst: `count by (build, signature) (sum by (build, signature, actor_id) (count_over_time(${events(platform, "client.crash")} [1h])))`,
  };
}

/** Every build's figures on one platform over the last 24 hours. */
export async function platformFigures(platform: ClientPlatform): Promise<Map<number, BuildFigures>> {
  const q = queries(platform);
  const [users, crashUsers, sessions, p50, p90, drops, seconds, fallbacks] = await Promise.all(
    [q.users, q.crashUsers, q.sessions, q.p50, q.p90, q.drops, q.seconds, q.fallbacks].map(instant));
  const figures = new Map<number, BuildFigures>();
  const at = (build: number) => { let f = figures.get(build); if (!f) figures.set(build, f = empty()); return f; };
  for (const [build, value] of byBuild(users)) at(build).users = value;
  for (const [build, value] of byBuild(crashUsers)) at(build).crashUsers = value;
  for (const row of sessions) {
    const build = Number(row.metric.build), count = Number(row.value[1]) || 0;
    if (!Number.isFinite(build)) continue;
    const f = at(build);
    f.sessions += count;
    if (row.metric.outcome === "ok" || row.metric.outcome === "lost") f.okSessions += count;
    if (row.metric.outcome === "failed") f.failedSessions += count;
  }
  for (const [build, value] of byBuild(p50)) at(build).connectP50 = Math.round(value);
  for (const [build, value] of byBuild(p90)) at(build).connectP90 = Math.round(value);
  for (const [build, value] of byBuild(drops)) at(build).drops = value;
  for (const [build, value] of byBuild(seconds)) at(build).connectedSeconds = value;
  for (const [build, value] of byBuild(fallbacks)) at(build).fallbackSessions = value;
  return figures;
}

async function crashBursts(platform: ClientPlatform) {
  const bursts = new Map<number, { signature: string; users: number }>();
  for (const row of await instant(queries(platform).burst)) {
    const build = Number(row.metric.build), users = Number(row.value[1]) || 0;
    if (Number.isFinite(build) && users > (bursts.get(build)?.users || 0)) bursts.set(build, { signature: row.metric.signature || "", users });
  }
  return bursts;
}

/** 7 daily points per build for each metric. Built from the same queries, so a point equals the verdict's figure that day. */
async function trends(platform: ClientPlatform) {
  const q = queries(platform);
  const [users, crashUsers, sessions, p90, drops, seconds] = await Promise.all([q.users, q.crashUsers, q.sessions, q.p90, q.drops, q.seconds].map(daily));
  const series = (rows: Matrix, filter: (metric: Record<string, string>) => boolean = () => true) => {
    const map = new Map<number, number[]>();
    for (const row of rows.filter((r) => filter(r.metric))) {
      const build = Number(row.metric.build);
      if (!Number.isFinite(build)) continue;
      const points = map.get(build) || Array(7).fill(0);
      const end = Date.now() / 1000;
      for (const [time, value] of row.values) { const index = 6 - Math.round((end - time) / 86400); if (index >= 0 && index < 7) points[index] += Number(value) || 0; }
      map.set(build, points);
    }
    return map;
  };
  const u = series(users), c = series(crashUsers), ok = series(sessions, (m) => m.outcome === "ok" || m.outcome === "lost"),
    failed = series(sessions, (m) => m.outcome === "failed"), p = series(p90), d = series(drops), s = series(seconds);
  return (build: number): Record<MetricKey, Array<number | null>> => {
    const pick = (map: Map<number, number[]>) => map.get(build) || Array(7).fill(0);
    const divide = (a: number[], b: number[], scale = 1) => a.map((value, i) => b[i] > 0 ? value / (b[i] * scale) : null);
    const okPoints = pick(ok), failedPoints = pick(failed);
    return {
      crash: divide(pick(c), pick(u)),
      success: okPoints.map((value, i) => value + failedPoints[i] > 0 ? value / (value + failedPoints[i]) : null),
      connectP90: pick(p).map((value) => value > 0 ? Math.round(value) : null),
      drops: divide(pick(d), pick(s), 1 / 3600),
    };
  };
}

const metricKeys: MetricKey[] = ["crash", "success", "connectP90", "drops"];

/** Health of each build in rollout against its stable baseline; [rollouts] lists platform + build + baseline build. */
export async function rolloutHealth(rollouts: Array<{ platform: ClientPlatform; build: number; baselineBuild: number | null }>): Promise<BuildHealth[]> {
  const platforms = [...new Set(rollouts.map((item) => item.platform))];
  const data = new Map(await Promise.all(platforms.map(async (platform) =>
    [platform, await Promise.all([platformFigures(platform), crashBursts(platform), trends(platform)])] as const)));
  return rollouts.map(({ platform, build, baselineBuild }) => {
    const [figures, bursts, trend] = data.get(platform)!;
    const current = figures.get(build) || empty();
    const baseline = baselineBuild === null ? null : figures.get(baselineBuild) || empty();
    const points = trend(build);
    const metrics = metricKeys.map((key) => ({ key, current: metricValue(key, current), baseline: baseline ? metricValue(key, baseline) : null, verdict: judge(key, current, baseline), trend: points[key] }));
    const crashBurst = bursts.get(build) || null;
    const reasons = [...hardStops(current, crashBurst), ...metrics.filter((m) => m.verdict === "bad").map((m) => m.key)];
    const verdict: Verdict = reasons.length ? "bad" : metrics.some((m) => m.verdict === "insufficient") ? "insufficient" : metrics.some((m) => m.verdict === "better") ? "better" : "ok";
    return { platform, build, baselineBuild, verdict, figures: current, baselineFigures: baseline, metrics,
      fallbackRate: fallbackRate(current), baselineFallbackRate: baseline ? fallbackRate(baseline) : null, crashBurst, reasons };
  });
}
