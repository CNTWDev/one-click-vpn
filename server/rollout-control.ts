import { dbExec, dbQuery } from "./db";
import { ReleaseError, transitionRelease, type ReleaseActor } from "./client-releases";
import { rolloutHealth, crashRate, successRate, dropsPerHour, type BuildHealth } from "./rollout-health";
import { decideRollout, nextStage, type RolloutStep } from "./rollout-rules";
import { writeOperationalLog } from "./operational-logs";
import { consoleLink, defineEvent, notify, registerApproval, requestApproval, settleApproval, type TelegramMessage } from "./telegram";
import type { ClientPlatform } from "../shared/client-releases";

/**
 * Staged rollout that runs itself. Every 15 minutes each stable build under 100% is judged against the stable
 * build it replaces (rollout-health.ts, from Loki) and moved on by rollout-rules.ts: widened to the next stage
 * after 24 healthy hours, frozen at once when a metric goes red, and a person is asked when there is too little
 * data for 48 hours. A frozen build is offered to nobody new; installs that already have it keep it.
 *
 * Everything a person decides comes through Telegram buttons (event "rollout") or the Console card; either one
 * closes the other's open question. A build is one platform + build number: Windows x64 and arm64 move together.
 */

defineEvent("rollout", { approval: true });

const PLATFORM_NAMES: Record<string, string> = { android: "Android", macos: "Mac", windows: "Windows", ios: "iPhone" };
const REASON_TEXT: Record<string, string> = {
  "crash-burst": "1 小时内多个用户出现同一个崩溃", "success-floor": "连接成功率低于 70%",
  crash: "崩溃率超红线", success: "连接成功率超红线", connectP90: "连上用时超红线", drops: "意外断线超红线", manual: "手动暂停",
};
const INTERVAL_MS = 15 * 60_000;

type Row = { id: string; platform: ClientPlatform; build: number; version: string; rollout_percent: number; rollout_since: Date | null;
  rollout_frozen_at: Date | null; rollout_override: number; rollout_asked_at: Date | null };
type Group = { platform: ClientPlatform; build: number; version: string; ids: string[]; percent: number; since: number; frozen: boolean; override: boolean; askedAt: number | null };

const label = (group: { platform: string; version: string }) => `${PLATFORM_NAMES[group.platform] || group.platform} ${group.version}`;
const reasonText = (reasons: string[]) => reasons.map((reason) => REASON_TEXT[reason] || reason).join("；") || "指标异常";
const pct = (value: number | null, digits = 1) => value === null ? "—" : `${(value * 100).toFixed(digits)}%`;

async function ownerActor(): Promise<ReleaseActor> {
  const id = (await dbQuery<{ id: string }>("SELECT id FROM users WHERE role = 'owner' ORDER BY created_at LIMIT 1"))[0]?.id;
  if (!id) throw new Error("no owner account");
  return { kind: "admin", userId: id };
}

async function stagedGroups(where = "channel = 'stable' AND status = 'published' AND rollout_percent < 100", params: unknown[] = []): Promise<Group[]> {
  const rows = await dbQuery<Row>(`SELECT id, platform, build, version, rollout_percent, rollout_since, rollout_frozen_at, rollout_override, rollout_asked_at
    FROM client_releases WHERE ${where} ORDER BY platform, build`, params);
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = `${row.platform}:${row.build}`;
    const group = groups.get(key);
    if (group) { group.ids.push(row.id); group.frozen ||= !!row.rollout_frozen_at; continue; }
    groups.set(key, { platform: row.platform, build: Number(row.build), version: row.version, ids: [row.id], percent: Number(row.rollout_percent),
      since: new Date(row.rollout_since ?? Date.now()).getTime(), frozen: !!row.rollout_frozen_at, override: !!row.rollout_override,
      askedAt: row.rollout_asked_at ? new Date(row.rollout_asked_at).getTime() : null });
  }
  return [...groups.values()];
}

async function baselineBuild(platform: ClientPlatform, build: number): Promise<number | null> {
  const row = (await dbQuery<{ build: number | null }>("SELECT MAX(build) AS build FROM client_releases WHERE platform = $1 AND channel = 'stable' AND status = 'published' AND rollout_percent = 100 AND build < $2", [platform, build]))[0];
  return row?.build === null || row?.build === undefined ? null : Number(row.build);
}

/** "崩溃率 0.4%（正式版 0.3%）" lines for a Telegram message. */
function figureLines(health: BuildHealth | undefined): TelegramMessage["fields"] {
  if (!health) return [];
  const pair = (now: string, before: string) => `${now}（正式版 ${before}）`;
  const base = health.baselineFigures;
  return [
    { label: "崩溃率", value: pair(pct(crashRate(health.figures), 2), base ? pct(crashRate(base), 2) : "—") },
    { label: "连接成功率", value: pair(pct(successRate(health.figures)), base ? pct(successRate(base)) : "—") },
    { label: "意外断线/小时", value: pair(dropsPerHour(health.figures)?.toFixed(2) ?? "—", base ? dropsPerHour(base)?.toFixed(2) ?? "—" : "—") },
    { label: "样本", value: `${health.figures.users} 个用户 · ${health.figures.sessions} 次连接` },
  ];
}

/**
 * One action on every installer of a build. A sibling already in the wanted state is skipped; it only fails
 * when no installer could change.
 */
async function each(actor: ReleaseActor, ids: string[], action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  let last: unknown = null, error: unknown = null, changed = 0;
  for (const id of ids) {
    try { last = await transitionRelease(actor, id, action, extra); changed++; }
    catch (failure) { if (!(failure instanceof ReleaseError) || failure.message !== "INVALID_RELEASE_STATE") throw failure; error = failure; }
  }
  if (!changed && error) throw error;
  return last;
}

let lastRun = 0;
let running = false;

/** Minute job; does its work every 15 minutes. Returns what it did, for tests and logs. */
export async function runRolloutControl(force = false): Promise<Array<{ platform: string; build: number; step: NonNullable<RolloutStep> }>> {
  if (running || (!force && Date.now() - lastRun < INTERVAL_MS)) return [];
  running = true; lastRun = Date.now();
  try {
    const groups = await stagedGroups();
    if (!groups.length) return [];
    const rollouts = await Promise.all(groups.map(async (group) => ({ platform: group.platform, build: group.build, baselineBuild: await baselineBuild(group.platform, group.build) })));
    let health: BuildHealth[] | null = null;
    try { health = await rolloutHealth(rollouts); } catch { health = null; }
    const done: Array<{ platform: string; build: number; step: NonNullable<RolloutStep> }> = [];
    for (const group of groups) {
      const item = health?.find((entry) => entry.platform === group.platform && entry.build === group.build);
      const step = decideRollout({ percent: group.percent, since: group.since, frozen: group.frozen, override: group.override, askedAt: group.askedAt,
        verdict: item ? item.verdict : null, reasons: item?.reasons ?? [] });
      if (!step) continue;
      await apply(group, step, item).catch((error) => console.error("Rollout step failed", (error as Error).message));
      done.push({ platform: group.platform, build: group.build, step });
    }
    return done;
  } finally { running = false; }
}

async function apply(group: Group, step: NonNullable<RolloutStep>, health: BuildHealth | undefined) {
  const actor = await ownerActor();
  const link = await consoleLink("/releases");
  if (step.kind === "widen") {
    await each(actor, group.ids, "rollout", { percent: step.to, via: "auto" });
    await log(group, "client_release.rollout_widened", "info", `${label(group)} widened to ${step.to}%`, { from: group.percent, to: step.to });
    if (step.to >= 100) await notify("rollout", { tone: "ok", title: `${label(group)} 已全量发布`, lines: ["灰度各阶段指标正常，所有用户都会收到这个版本。"], link });
    else await requestApproval({ kind: "rollout-pause", target: `${group.platform}:${group.build}:${step.to}`, event: "rollout", approveLabel: "⏸ 暂停", rejectLabel: null,
      message: { tone: "info", title: `${label(group)} 已放量到 ${step.to}%`, lines: [`上一档 ${group.percent}% 运行满 24 小时，指标正常。下一档至少 24 小时后。`], fields: figureLines(health), link } });
    return;
  }
  if (step.kind === "freeze") {
    const reason = step.reasons.join(",") || "metrics";
    await each(actor, group.ids, "freeze", { reason, via: "auto" });
    await log(group, "client_release.rollout_frozen", "warning", `${label(group)} frozen at ${group.percent}%: ${reason}`, { percent: group.percent, reasons: step.reasons });
    await requestApproval({ kind: "rollout-freeze", target: `${group.platform}:${group.build}:${Date.now()}`, event: "rollout", approveLabel: "▶️ 继续灰度", rejectLabel: "⛔ 撤回",
      message: { tone: "alert", title: `${label(group)} 灰度已自动暂停`, lines: [`原因：${reasonText(step.reasons)}`, `停在 ${group.percent}%，新用户不再收到这个版本，已升级的照常使用。不处理就一直保持暂停。`],
        fields: [...(health?.crashBurst ? [{ label: "崩溃签名", value: health.crashBurst.signature, code: true }] : []), ...(figureLines(health) ?? [])], link } });
    return;
  }
  await dbExec("UPDATE client_releases SET rollout_asked_at = now() WHERE id = ANY($1)", [group.ids]);
  await requestApproval({ kind: "rollout-ask", target: `${group.platform}:${group.build}:${Date.now()}`, event: "rollout", approveLabel: `▶️ 放量到 ${nextStage(group.percent)}%`, rejectLabel: "⏳ 再等 24 小时",
    message: { tone: "approval", title: `${label(group)} 样本不足，要继续放量吗？`, lines: [`在 ${group.percent}% 已经 ${Math.floor((Date.now() - group.since) / 3600_000)} 小时，用户还不够多，指标没法判断，也没有出现硬性问题。`], fields: figureLines(health), link } });
}

async function log(group: Group, action: string, level: "info" | "warning", message: string, fields: Record<string, unknown>) {
  await writeOperationalLog({ component: "controller", level, source: "system", action, message, fields: { platform: group.platform, build: group.build, version: group.version, ...fields } }).catch(() => undefined);
}

function parseTarget(target: string): { platform: ClientPlatform; build: number } | null {
  const [platform, build] = target.split(":");
  return platform && Number.isInteger(Number(build)) ? { platform: platform as ClientPlatform, build: Number(build) } : null;
}

async function groupFor(target: string): Promise<Group | null> {
  const parsed = parseTarget(target);
  if (!parsed) return null;
  return (await stagedGroups("platform = $1 AND build = $2 AND channel = 'stable' AND status = 'published'", [parsed.platform, parsed.build]))[0] ?? null;
}

registerApproval("rollout-pause", {
  async decide(target, _approve, by) {
    const group = await groupFor(target);
    if (!group || group.percent >= 100 || group.frozen) return "已在 Console 处理";
    const actor = await ownerActor();
    await each(actor, group.ids, "freeze", { reason: "manual", via: `telegram:${by.telegramId}` });
    return "⏸ 已暂停";
  },
});

registerApproval("rollout-freeze", {
  async decide(target, approve, by) {
    const group = await groupFor(target);
    if (!group || !group.frozen) return "已在 Console 处理";
    const actor = await ownerActor();
    if (approve) { await each(actor, group.ids, "resume", { via: `telegram:${by.telegramId}` }); return `▶️ 继续灰度，${group.percent}%`; }
    await each(actor, group.ids, "withdraw", { via: `telegram:${by.telegramId}` });
    return "⛔ 已撤回";
  },
});

registerApproval("rollout-ask", {
  async decide(target, approve, by) {
    const group = await groupFor(target);
    if (!group || group.frozen || group.percent >= 100) return "已在 Console 处理";
    if (!approve) return "⏳ 24 小时后再问";
    const to = nextStage(group.percent);
    const actor = await ownerActor();
    await each(actor, group.ids, "rollout", { percent: to, via: `telegram:${by.telegramId}` });
    return `▶️ 已放量到 ${to}%`;
  },
});

/** Console decided for this build: close any open Telegram question about it. */
export async function settleRollout(platform: string, build: number, footer: string): Promise<void> {
  const open = await dbQuery<{ kind: string; target: string }>("SELECT kind, target FROM telegram_approvals WHERE status = 'pending' AND kind LIKE 'rollout-%' AND target LIKE $1", [`${platform}:${build}:%`]).catch(() => []);
  for (const row of open) await settleApproval(row.kind, row.target, footer);
}

export type RolloutAction = "freeze" | "resume" | "full" | "withdraw";
const FOOTERS: Record<RolloutAction, string> = { freeze: "⏸ 已在 Console 暂停", resume: "▶️ 已在 Console 继续", full: "⏩ 已在 Console 全量", withdraw: "⛔ 已在 Console 撤回" };

/** Console card: one action for every installer of the build (Windows x64 + arm64 together). */
export async function rolloutAction(actor: ReleaseActor, releaseId: string, action: unknown) {
  if (!(["freeze", "resume", "full", "withdraw"] as unknown[]).includes(action)) throw new ReleaseError("INVALID_ACTION");
  const kind = action as RolloutAction;
  const row = (await dbQuery<{ platform: ClientPlatform; build: number }>("SELECT platform, build FROM client_releases WHERE id = $1", [releaseId]))[0];
  if (!row) throw new ReleaseError("RELEASE_NOT_FOUND", 404);
  const ids = (await dbQuery<{ id: string }>("SELECT id FROM client_releases WHERE platform = $1 AND build = $2 AND channel = 'stable' AND status = 'published'", [row.platform, row.build])).map((item) => item.id);
  if (!ids.length) throw new ReleaseError("INVALID_RELEASE_STATE", 409);
  const last = kind === "full" ? await each(actor, ids, "rollout", { percent: 100 }) : await each(actor, ids, kind, kind === "freeze" ? { reason: "manual" } : {});
  await settleRollout(row.platform, Number(row.build), FOOTERS[kind]);
  return last;
}
