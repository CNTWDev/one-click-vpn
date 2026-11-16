import { useEffect, useState } from "react";
import { useI18n } from "../../shared/i18n";
import { api, isUnauthorized } from "./api";
import { formatBytes } from "./format";
import { InlineError, Skeleton } from "./ui";

type Totals = { totalBytes: number; uploadBytes?: number; downloadBytes?: number };
export type Usage = { totals: Totals; daily?: { day: string; totalBytes: number }[] };
type Breakdown = {
  totals: Totals;
  nodes: { nodeId: string; name: string; countryCode: string | null; totalBytes: number }[];
  devices: { deviceId: string; name: string; platform: string; subscription: boolean; totalBytes: number }[];
};
type Range = "today" | "month" | "d30";

const DAY = 86_400_000;
/** Traffic days are UTC dates on the server, so the ranges are too. */
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
function bounds(range: Range) {
  const today = utcDay(Date.now());
  return { from: range === "today" ? today : range === "month" ? `${today.slice(0, 8)}01` : utcDay(Date.now() - 29 * DAY), to: today };
}
/** The chart's columns: the days of the range (this month runs to its last day, future days empty); today shows the last 30 days with today lit. */
function columns(range: Range, usage: Usage) {
  const perDay = new Map((usage.daily || []).map((row) => [String(row.day).slice(0, 10), Number(row.totalBytes) || 0]));
  const today = utcDay(Date.now());
  let days: string[];
  if (range === "month") {
    const start = Date.parse(`${today.slice(0, 8)}01T00:00:00Z`), first = new Date(start);
    const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    days = Array.from({ length }, (_, i) => utcDay(start + i * DAY));
  } else days = Array.from({ length: 30 }, (_, i) => utcDay(Date.now() - (29 - i) * DAY));
  return days.map((day) => ({ day, bytes: perDay.get(day) || 0, future: day > today, lit: range !== "today" || day === today }));
}
const ROWS = 18;
const shortDay = (day: string) => day.slice(5);

const platformCodes: Record<string, string> = { android: "AND", ios: "IOS", macos: "MAC", mac: "MAC", windows: "WIN" };
const platformNames: Record<string, string> = { android: "Android", ios: "iPhone / iPad", macos: "macOS", mac: "macOS", windows: "Windows" };

/** One ranking row: a three-letter tile, the name over a dotted bar sized against the first row, and the amount. */
function Rank({ code, name, bytes, top, muted = false }: { code: string; name: string; bytes: number; top: number; muted?: boolean }) {
  return <li>
    <span className={`home-code${muted ? " off" : ""}`} aria-hidden="true">{code}</span>
    <span className="usage-rank-main"><b title={name}>{name}</b>
      <i className="usage-track" aria-hidden="true"><i style={{ width: `${Math.max(4, Math.round((bytes / Math.max(top, 1)) * 100))}%` }} /></i></span>
    <span className="usage-rank-value">{formatBytes(bytes)}</span>
  </li>;
}

/**
 * The account's usage on the Portal home: today / this month / the last 30 days, the daily columns, and where the
 * traffic went by node and by device. `usage` holds the last 31 days for the chart; the totals and rankings come per range.
 */
export function UsageCard({ usage, onLogout }: { usage: Usage | null; onLogout: () => void }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("month");
  const [data, setData] = useState<Partial<Record<Range, Breakdown>>>({});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const current = data[range];

  useEffect(() => {
    let live = true;
    const { from, to } = bounds(range);
    api<Breakdown>(`/api/v1/usage/breakdown?from=${from}&to=${to}`)
      .then((result) => { if (live) { setData((old) => ({ ...old, [range]: { totals: result.totals || { totalBytes: 0 }, nodes: result.nodes || [], devices: result.devices || [] } })); setError(""); } })
      .catch((caught) => { if (!live) return; if (isUnauthorized(caught)) onLogout(); else setError((caught as Error).message); });
    return () => { live = false; };
    // Refetched when the home refreshes its figures (every 30 s); the last answer stays on screen meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, attempt, usage]);

  const cols = usage ? columns(range, usage) : [];
  // Columns scale against every shown day (today's view keeps the other days, dimmed); the label names the range's busiest day.
  const scale = Math.max(1, ...cols.map((col) => col.bytes));
  const peak = Math.max(0, ...cols.filter((col) => col.lit && !col.future).map((col) => col.bytes));
  const height = (bytes: number) => bytes <= 0 ? 1 : Math.min(ROWS, Math.max(1, Math.round(ROWS * bytes / scale)));
  const [value, unit = ""] = current ? formatBytes(current.totals.totalBytes).split(" ") : ["", ""];
  const ranges: [Range, string][] = [["today", t("今日")], ["month", t("本月")], ["d30", t("近 30 天")]];
  const deviceName = (device: Breakdown["devices"][number]) => device.subscription ? t("订阅链接")
    : platformNames[device.platform] ? `${platformNames[device.platform]} · ${device.name}` : device.name || t("单节点配置");

  return <section className="card usage-card" aria-labelledby="usage-title">
    <div className="usage-head">
      <h2 id="usage-title">{t("用量")}</h2>
      <div className="usage-ranges" role="group" aria-label={t("时间范围")}>
        {ranges.map(([key, label]) => <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>{label}</button>)}
      </div>
    </div>
    {error ? <InlineError message={error} onRetry={() => { setError(""); setAttempt((n) => n + 1); }} /> : <>
      <div className="usage-figure">
        {current ? <strong className="pixel-figure">{value}<span className="unit">{unit}</span></strong> : <Skeleton height={34} width={140} />}
        {current && <span className="home-stat-note mono">↓ {formatBytes(current.totals.downloadBytes || 0)} · ↑ {formatBytes(current.totals.uploadBytes || 0)}</span>}
      </div>
      {usage && <div className="usage-chart-wrap">
        <div className="usage-chart" aria-hidden="true">
          {cols.map((col) => <span key={col.day} className={col.future ? "future" : col.lit ? undefined : "dim"} style={{ height: `${height(col.future ? 0 : col.bytes) * 6 - 2}px` }} />)}
        </div>
        <div className="usage-axis" aria-hidden="true"><span>{shortDay(cols[0].day)}</span><span>{shortDay(cols[Math.floor(cols.length / 2)].day)}</span><span>{shortDay(cols[cols.length - 1].day)}</span></div>
        <p className="usage-peak mono">{t("单日最高 {0}", [formatBytes(peak)])}</p>
      </div>}
      {current && (current.nodes.length > 0 || current.devices.length > 0) && <div className="usage-ranks">
        <div><h3>{t("按线路")}</h3>
          {current.nodes.length ? <ul>{current.nodes.map((node) => <Rank key={node.nodeId} code={node.countryCode || "··"} name={node.name || node.nodeId} bytes={node.totalBytes} top={current.nodes[0].totalBytes} />)}</ul>
            : <p className="hint">{t("这段时间没有用量。")}</p>}</div>
        <div><h3>{t("按设备")}</h3>
          {current.devices.length ? <ul>{current.devices.map((device) => <Rank key={device.deviceId} code={device.subscription ? "SUB" : platformCodes[device.platform] || "CFG"} name={deviceName(device)} bytes={device.totalBytes} top={current.devices[0].totalBytes} muted={!device.subscription && !platformCodes[device.platform]} />)}</ul>
            : <p className="hint">{t("这段时间没有用量。")}</p>}</div>
      </div>}
      {current && !current.nodes.length && !current.devices.length && <p className="hint usage-empty">{t("这段时间没有用量。")}</p>}
    </>}
  </section>;
}

/** Remaining traffic as a row of square blocks; the lit share is what is left. */
export function QuotaBlocks({ used, quota, low }: { used: number; quota: number; low: boolean }) {
  const count = 20, left = Math.max(0, Math.min(count, Math.round(count * (1 - used / Math.max(quota, 1)))));
  return <span className={`quota-blocks${low ? " low" : ""}`} aria-hidden="true">
    {Array.from({ length: count }, (_, i) => <i key={i} className={i < left ? "on" : undefined} />)}
  </span>;
}
