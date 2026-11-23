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
type ReleaseLite = { platform: Platform; build: number; version: string; channel: string; status: string; rolloutPercent: number };

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

function Stages({ current }: { current: number }) {
  const at = stages.filter((stage) => stage <= current).pop() ?? 0;
  return <div className="rollout-stages" aria-label={t("灰度阶段")}>
    <div className="rollout-stage done"><i /><span>{t("测试版")}</span></div>
    {stages.map((stage) => <div key={stage} className={`rollout-stage${stage < at ? " done" : stage === at ? " now" : ""}`}><i /><span>{stage}%</span></div>)}
  </div>;
}

export function RolloutHealthPanel({ health, error, releases }: { health: BuildHealth[]; error: string | null; releases: ReleaseLite[] }) {
  useConsoleLanguage();
  if (!health.length && !error) return null;
  return <section className="rollout-health">
    <div className="panel-head"><div><h2>{t("正在灰度的版本")}</h2><p>{t("新版本和同平台当前正式版在最近 24 小时里对比；数据来自客户端上报，只存在运行日志里。")}</p></div></div>
    {error && <p className="rollout-error">{t("暂时读不到运行日志，指标稍后再看。")}</p>}
    {health.map((item) => {
      const release = releases.find((row) => row.platform === item.platform && row.build === item.build && row.channel === "stable" && row.status === "published");
      const baseline = releases.find((row) => row.platform === item.platform && row.build === item.baselineBuild);
      const rollout = release?.rolloutPercent ?? 0;
      return <article key={`${item.platform}:${item.build}`} className={`rollout-card${item.verdict === "bad" ? " alarm" : ""}`}>
        <div className="rollout-title">
          <b>{platformNames[item.platform]} {release?.version ?? ""}</b><small>{t("构建 {0}", [item.build])}</small>
          {verdictPill(item.verdict, "build")}
        </div>
        <Stages current={rollout} />
        <p className="rollout-summary">{t("当前 {0}% · 新版 {1} 个活跃用户、{2} 次连接 · 正式版 {3} 个活跃用户", [rollout, item.figures.users, item.figures.sessions, item.baselineFigures?.users ?? 0])}</p>
        {item.reasons.includes("crash-burst") && item.crashBurst && <p className="rollout-reason">{t("1 小时内 {0} 个用户出现同一个崩溃（签名 {1}），在运行日志里搜索这个签名可以看到详情。", [item.crashBurst.users, item.crashBurst.signature])}</p>}
        {item.reasons.includes("success-floor") && <p className="rollout-reason">{t("新版连接成功率低于 70%。")}</p>}
        <div className="rollout-metrics" role="table" aria-label={t("指标对比")}>
          <div className="rollout-metric head" role="row"><span role="columnheader">{t("指标（近 24 小时）")}</span><span role="columnheader">{t("构建 {0}", [item.build])}</span><span role="columnheader">{baseline ? t("正式版 {0}", [baseline.version]) : t("正式版")}</span><span role="columnheader">{t("近 7 天")}</span><span role="columnheader">{t("状态")}</span></div>
          {item.metrics.map((metric) => { const label = metricName(metric.key); return <div key={metric.key} role="row" className={`rollout-metric${metric.verdict === "bad" ? " alarm" : ""}`}>
            <span role="cell" className="name">{label.name}<small>{label.limit}</small></span>
            <span role="cell" className="num">{metricText(metric.key, metric.current)}</span>
            <span role="cell" className="num">{metricText(metric.key, metric.baseline)}</span>
            <span role="cell"><Spark points={metric.trend} bad={metric.verdict === "bad"} /></span>
            <span role="cell">{verdictPill(metric.verdict, "metric")}</span>
          </div>; })}
        </div>
        <p className="rollout-observed">{t("只看不判：协议回退 {0}（正式版 {1}） · 连上用时 P50 {2}（正式版 {3}）", [percent(item.fallbackRate, 0), percent(item.baselineFallbackRate, 0), seconds(item.figures.connectP50), seconds(item.baselineFigures?.connectP50 ?? null)])}</p>
      </article>;
    })}
  </section>;
}
