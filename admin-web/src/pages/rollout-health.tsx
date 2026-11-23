import { t, useConsoleLanguage } from "../i18n";
import { Pill } from "./shared";
import "./rollout-health.css";

type Platform = "android" | "ios" | "macos" | "windows";
type Verdict = "ok" | "better" | "bad" | "insufficient";
type MetricKey = "crash" | "success" | "connectP90" | "drops";
type Figures = { users: number; sessions: number; okSessions: number; failedSessions: number; connectP50: number | null; connectP90: number | null };
export type BuildHealth = {
  platform: Platform; build: number; baselineBuild: number | null; verdict: Verdict;
  figures: Figures; baselineFigures: Figures | null;
  metrics: Array<{ key: MetricKey; current: number | null; baseline: number | null; verdict: Verdict; trend: Array<number | null> }>;
  fallbackRate: number | null; baselineFallbackRate: number | null;
  crashBurst: { signature: string; users: number } | null; reasons: string[];
};
type ReleaseLite = { id: string; platform: Platform; build: number; version: string; channel: string; status: string; rolloutPercent: number;
  rolloutSince?: string | null; rolloutFrozenAt?: string | null; rolloutFreezeReason?: string };
export type RolloutAction = "freeze" | "resume" | "full" | "withdraw";

const platformNames: Record<Platform, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", windows: "Windows" };
const stages = [10, 30, 60, 100];

const percent = (value: number | null, digits = 1) => value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
const seconds = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(1)} s`;
const perHour = (value: number | null) => value === null ? "—" : value.toFixed(2);

function metricText(key: MetricKey, value: number | null) {
  if (key === "crash") return percent(value, 2);
  if (key === "success") return percent(value);
  if (key === "connectP90") return seconds(value);
  return perHour(value);
}

function metricName(key: MetricKey) {
  if (key === "crash") return { name: t("崩溃率"), limit: t("红线：旧版 ×1.5 或 1%") };
  if (key === "success") return { name: t("连接成功率"), limit: t("红线：比旧版低 2 个百分点") };
  if (key === "connectP90") return { name: t("连上用时 P90"), limit: t("红线：超过旧版 ×1.3 且多 2 秒") };
  return { name: t("意外断线"), limit: t("每连接小时；红线：旧版 ×1.5") };
}

function verdictPill(verdict: Verdict, scope: "metric" | "build") {
  if (verdict === "bad") return <Pill value="bad" tone="danger" label={t("超红线")} />;
  if (verdict === "insufficient") return <Pill value="insufficient" tone="neutral" label={t("样本不足")} />;
  if (verdict === "better") return <Pill value="better" tone="success" label={t("更好")} />;
  return <Pill value="ok" tone="success" label={scope === "build" ? t("指标正常") : t("正常")} />;
}

/** 7 daily points, the last one marked; a gap where a day had no data. */
function Spark({ points, bad }: { points: Array<number | null>; bad: boolean }) {
  const values = points.filter((value): value is number => value !== null);
  if (values.length < 2) return <span className="spark-empty">—</span>;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1, w = 100, h = 28, pad = 4;
  const xy = points.map((value, i) => value === null ? null : [pad + i * (w - 2 * pad) / (points.length - 1), h - pad - (value - lo) / span * (h - 2 * pad)] as const);
  const drawn = xy.filter((point): point is readonly [number, number] => point !== null);
  const line = drawn.map((point) => point.join(",")).join(" ");
  const last = drawn[drawn.length - 1];
  return <svg className={`spark${bad ? " bad" : ""}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <polygon points={`${drawn[0][0]},${h} ${line} ${last[0]},${h}`} />
    <polyline points={line} vectorEffect="non-scaling-stroke" />
    <circle cx={last[0]} cy={last[1]} r="2.2" />
  </svg>;
}

const STAGE_HOURS = 24;
const hoursSince = (iso: string | null | undefined) => iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 3600_000)) : null;

function reasonText(reason: string) {
  const names: Record<string, string> = { "crash-burst": t("同一个崩溃集中出现"), "success-floor": t("连接成功率低于 70%"), crash: t("崩溃率"), success: t("连接成功率"),
    connectP90: t("连上用时 P90"), drops: t("意外断线"), manual: t("手动暂停") };
  return reason.split(",").filter(Boolean).map((item) => names[item] || item).join(t("、"));
}

/** Where the stage stands in words: frozen and why, or how long until the next automatic step. */
function stageLine(release: ReleaseLite, verdict: Verdict | null) {
  const hours = hoursSince(release.rolloutSince);
  if (release.rolloutFrozenAt) return release.rolloutFreezeReason === "manual" ? t("已暂停：新用户不再收到这个版本，已升级的照常使用。") : t("已自动暂停（{0}）：新用户不再收到这个版本，已升级的照常使用。", [reasonText(release.rolloutFreezeReason || "")]);
  if (hours === null) return "";
  if (hours < STAGE_HOURS) return t("这一档已 {0} 小时，满 24 小时且指标正常会自动放量。", [hours]);
  if (verdict === "insufficient") return t("这一档已 {0} 小时，样本还不够判断；满 48 小时会在 Telegram 问你。", [hours]);
  return t("这一档已 {0} 小时，下次检查时会自动放量。", [hours]);
}

function Stages({ current }: { current: number }) {
  const at = stages.filter((stage) => stage <= current).pop() ?? 0;
  return <div className="rollout-stages" aria-label={t("灰度阶段")}>
    <div className="rollout-stage done"><i /><span>{t("测试版")}</span></div>
    {stages.map((stage) => <div key={stage} className={`rollout-stage${stage < at ? " done" : stage === at ? " now" : ""}`}><i /><span>{stage}%</span></div>)}
  </div>;
}

export function RolloutHealthPanel({ health, error, releases, busy, onAction }: { health: BuildHealth[]; error: string | null; releases: ReleaseLite[]; busy: boolean; onAction: (release: ReleaseLite, action: RolloutAction) => void }) {
  useConsoleLanguage();
  // One card per build in staged rollout (stable, published, under 100%); Windows x64 and arm64 share one.
  const staged = [...new Map(releases.filter((row) => row.channel === "stable" && row.status === "published" && row.rolloutPercent < 100)
    .map((row) => [`${row.platform}:${row.build}`, row])).values()];
  if (!staged.length) return null;
  return <section className="rollout-health">
    <div className="panel-head"><div><h2>{t("正在灰度的版本")}</h2><p>{t("新版本和同平台当前正式版在最近 24 小时里对比，每档至少 24 小时，指标正常自动放量，超红线自动暂停；数据来自客户端上报，只存在运行日志里。")}</p></div></div>
    {error && <p className="rollout-error">{t("暂时读不到运行日志，指标稍后再看。")}</p>}
    {staged.map((release) => {
      const item = health.find((row) => row.platform === release.platform && row.build === release.build);
      const baseline = item && releases.find((row) => row.platform === item.platform && row.build === item.baselineBuild);
      const frozen = !!release.rolloutFrozenAt;
      const rollout = release.rolloutPercent;
      return <article key={`${release.platform}:${release.build}`} className={`rollout-card${item?.verdict === "bad" || frozen ? " alarm" : ""}`}>
        <div className="rollout-title">
          <b>{platformNames[release.platform]} {release.version}</b><small>{t("构建 {0}", [release.build])}</small>
          {frozen ? <Pill value="frozen" tone="danger" label={t("已暂停")} /> : item ? verdictPill(item.verdict, "build") : null}
        </div>
        <Stages current={rollout} />
        <p className="rollout-summary">{item ? t("当前 {0}% · 新版 {1} 个活跃用户、{2} 次连接 · 正式版 {3} 个活跃用户", [rollout, item.figures.users, item.figures.sessions, item.baselineFigures?.users ?? 0]) : t("当前 {0}%", [rollout])}</p>
        <p className="rollout-summary">{stageLine(release, item?.verdict ?? null)}</p>
        {item?.reasons.includes("crash-burst") && item.crashBurst && <p className="rollout-reason">{t("1 小时内 {0} 个用户出现同一个崩溃（签名 {1}），在运行日志里搜索这个签名可以看到详情。", [item.crashBurst.users, item.crashBurst.signature])}</p>}
        {item?.reasons.includes("success-floor") && <p className="rollout-reason">{t("新版连接成功率低于 70%。")}</p>}
        {item && <div className="rollout-metrics" role="table" aria-label={t("指标对比")}>
          <div className="rollout-metric head" role="row"><span role="columnheader">{t("指标（近 24 小时）")}</span><span role="columnheader">{t("构建 {0}", [item.build])}</span><span role="columnheader">{baseline ? t("正式版 {0}", [baseline.version]) : t("正式版")}</span><span role="columnheader">{t("近 7 天")}</span><span role="columnheader">{t("状态")}</span></div>
          {item.metrics.map((metric) => { const label = metricName(metric.key); return <div key={metric.key} role="row" className={`rollout-metric${metric.verdict === "bad" ? " alarm" : ""}`}>
            <span role="cell" className="name">{label.name}<small>{label.limit}</small></span>
            <span role="cell" className="num">{metricText(metric.key, metric.current)}</span>
            <span role="cell" className="num">{metricText(metric.key, metric.baseline)}</span>
            <span role="cell"><Spark points={metric.trend} bad={metric.verdict === "bad"} /></span>
            <span role="cell">{verdictPill(metric.verdict, "metric")}</span>
          </div>; })}
        </div>}
        {item && <p className="rollout-observed">{t("只看不判：协议回退 {0}（正式版 {1}） · 连上用时 P50 {2}（正式版 {3}）", [percent(item.fallbackRate, 0), percent(item.baselineFallbackRate, 0), seconds(item.figures.connectP50), seconds(item.baselineFigures?.connectP50 ?? null)])}</p>}
        <div className="rollout-actions">
          {frozen ? <button className="button primary small" disabled={busy} onClick={() => onAction(release, "resume")}>{t("继续灰度")}</button>
            : <button className="button ghost small" disabled={busy} onClick={() => onAction(release, "freeze")}>{t("暂停")}</button>}
          <button className="button ghost small" disabled={busy} onClick={() => onAction(release, "full")}>{t("直接全量")}</button>
          <button className="button danger small" disabled={busy} onClick={() => onAction(release, "withdraw")}>{t("撤回")}</button>
        </div>
      </article>;
    })}
  </section>;
}
