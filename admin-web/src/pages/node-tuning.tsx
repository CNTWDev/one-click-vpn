/* eslint-disable react-hooks/set-state-in-effect -- loads the test list when the node opens */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { consoleLanguage, t } from "../i18n";
import type { NodeRecord, NodeSpeedTest } from "../types";
import { formatBytes, Time } from "./shared";

type SpeedView = { pending: { id: string; status: string } | null; tests: NodeSpeedTest[]; agent?: "outdated" };

const mbps = (value: number | null | undefined) => value === null || value === undefined ? "—" : `${consoleLanguage.number(value, { maximumFractionDigits: value < 100 ? 1 : 0 })} Mbps`;

/** The latest "after" result with the "before" the Agent took just ahead of it (first tuning of the node). */
export function tuningGain(tests: NodeSpeedTest[]): { before: NodeSpeedTest; after: NodeSpeedTest } | null {
  const index = tests.findIndex((test) => test.kind === "after" && test.downMbps);
  const before = index < 0 ? undefined : tests.slice(index + 1).find((test) => test.kind === "before");
  return index >= 0 && before?.downMbps ? { before, after: tests[index] } : null;
}

function congestionText(node: NodeRecord, outdated: boolean): { title: string; detail: string; good: boolean } {
  const tuning = node.metrics?.tuning;
  const buffer = tuning?.udpBuffer ? t("UDP 缓冲 {0}", [formatBytes(tuning.udpBuffer)]) : "";
  if (!tuning) return { title: "—", detail: outdated ? t("升级 Agent 后开启") : t("等待心跳上报"), good: false };
  if (tuning.state === "tuned") return { title: "BBR", detail: buffer, good: true };
  if (tuning.state === "no-bbr") return { title: tuning.congestion || "—", detail: t("内核不支持 BBR · {0}", [buffer]), good: false };
  if (tuning.state === "unsupported") return { title: tuning.congestion || "—", detail: t("系统不允许修改（容器机器）"), good: false };
  return { title: tuning.congestion || "—", detail: t("正在开启…"), good: false };
}

/**
 * 网络调优: BBR and socket buffers the Agent turns on by itself (2.20+), the node's own connection speed from its
 * latest test, and the gain from tuning when the Agent measured before and after. 重新测速 asks for a test now.
 */
export function NodeTuning({ node, outdated }: { node: NodeRecord; outdated: boolean }) {
  const [view, setView] = useState<SpeedView | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = useCallback(async () => {
    try {
      const answer = await api<Partial<SpeedView>>(`/api/nodes/${node.id}/speed-test`);
      const next: SpeedView = { pending: answer.pending || null, tests: Array.isArray(answer.tests) ? answer.tests : [] };
      if (live.current) setView(next);
      return next;
    } catch { return null; }
  }, [node.id]);
  useEffect(() => { void load(); }, [load]);
  // While a test waits or runs (about 20 s), look again every few seconds.
  useEffect(() => {
    if (!view?.pending) return;
    const timer = window.setTimeout(() => void load(), 4000);
    return () => window.clearTimeout(timer);
  }, [view, load]);
  async function run() {
    setFailed(false);
    try {
      const started = await api<Partial<SpeedView>>(`/api/nodes/${node.id}/speed-test`, { method: "POST" });
      if (started.agent === "outdated") return setView((current) => ({ pending: null, tests: current?.tests || [], agent: "outdated" }));
      setView((current) => ({ pending: started.pending || null, tests: current?.tests || [] }));
    } catch { setFailed(true); }
  }
  const latest = view?.tests.find((test) => test.kind !== "before" && !test.error) || view?.tests.find((test) => !test.error);
  const lastError = view?.tests[0]?.error ? view.tests[0] : undefined;
  const gain = view ? tuningGain(view.tests) : null;
  const congestion = congestionText(node, outdated);
  const testing = Boolean(view?.pending);
  const offline = node.status === "offline" || node.status === "provisioning";
  const hint = view?.agent === "outdated" || outdated ? t("升级 Agent 到 2.20 后自动开启 BBR 并测速。")
    : failed ? t("没能发起测速，稍后重试。")
      : testing ? t("正在测速，约 30 秒…")
        : lastError ? t("最近一次测速失败：{0}", [lastError.error])
          : t("测的是节点到 Cloudflare 的出口上限，不是用户到节点的速度。");
  return (
    <section className="node-tuning">
      <div className="diagnostic-section-head">
        <div>
          <h3>{t("网络调优")}</h3>
          <p>{hint}</p>
        </div>
        <button className="button soft small" disabled={testing || offline || outdated} onClick={() => void run()}>{testing ? t("测速中…") : t("重新测速")}</button>
      </div>
      <div className="tuning-cards">
        <article className={congestion.good ? "good" : undefined}>
          <small>{t("拥塞控制")}</small>
          <b>{congestion.title}</b>
          <span>{congestion.detail}</span>
        </article>
        <article>
          <small>{t("下行")}</small>
          <b>{mbps(latest?.downMbps)}</b>
          <span>{latest ? <Time value={latest.createdAt} prefix={t("测于")} /> : view ? t("还没有测速") : "—"}</span>
        </article>
        <article>
          <small>{t("上行")}</small>
          <b>{mbps(latest?.upMbps)}</b>
          <span>{latest?.latencyMs !== null && latest?.latencyMs !== undefined ? t("延迟 {0} ms", [consoleLanguage.number(latest.latencyMs, { maximumFractionDigits: 0 })]) : "—"}</span>
        </article>
      </div>
      {gain && (
        <p className="tuning-gain">
          {t("调优前后")}
          <span>{t("下行 {0} → {1}", [mbps(gain.before.downMbps), mbps(gain.after.downMbps)])}</span>
          {gain.before.upMbps && gain.after.upMbps ? <span>{t("上行 {0} → {1}", [mbps(gain.before.upMbps), mbps(gain.after.upMbps)])}</span> : null}
        </p>
      )}
    </section>
  );
}
