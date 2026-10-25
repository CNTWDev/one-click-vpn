import { consoleLanguage, t } from "../i18n";
import { protocolName, statusLabel } from "../status";
import type { NodeDiagnostics, NodeRecord } from "../types";
import { Empty, formatBytes, formatRate, formatTime, InlineNotice, Pill, Time } from "./shared";

/** Live network speed from the last two heartbeats, or null before the second one arrives. */
export function liveRate(node: NodeRecord): { rx: number; tx: number } | null {
  const network = node.metrics?.network;
  if (node.status !== "online" || network?.wanRxBytesPerSecond === undefined || network.wanTxBytesPerSecond === undefined) return null;
  return { rx: network.wanRxBytesPerSecond, tx: network.wanTxBytesPerSecond };
}

function actionLabel(value: string): string {
  return (
    (
      { bootstrap: t("安装 / 修复 Agent"), "upgrade-agent": t("升级 Agent"), "status-agent": t("检查 Agent"), "restart-agent": t("重启 Agent") } as Record<
        string,
        string
      >
    )[value] || value.replaceAll("-", " ")
  );
}

function phaseLabel(value?: string): string {
  if (!value) return t("等待开始");
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

/**
 * What the Console knows about one node: the current task, identity and resources, the deployment log,
 * protocol health, configuration sync and the raw output of every operation. Read-only; actions stay on
 * the node page.
 */
export function NodeDiagnosticsView({ node, diagnostics, outdated }: { node: NodeRecord; diagnostics: NodeDiagnostics; outdated: boolean }) {
  return (
    <div className="diagnostics">
      {diagnostics.actions[0] ? (
        <section className={`current-job ${diagnostics.actions[0].status}`}>
          <div className="current-job-head">
            <div>
              <p className="eyebrow">{t("当前 / 最近任务")}</p>
              <h3>{actionLabel(diagnostics.actions[0].action)}</h3>
              <span>
                {phaseLabel(diagnostics.actions[0].current_phase)} · <Pill value={diagnostics.actions[0].status} />
              </span>
            </div>
            <Time value={diagnostics.actions[0].finished_at || diagnostics.actions[0].started_at || diagnostics.actions[0].created_at} />
          </div>
          <div className="job-progress">
            <i style={{ width: `${Math.min(Math.max(diagnostics.actions[0].progress || 0, 0), 100)}%` }} />
            <span>{diagnostics.actions[0].progress || 0}%</span>
          </div>
          {diagnostics.actions[0].error && <pre className="job-error">{diagnostics.actions[0].error}</pre>}
        </section>
      ) : (
        <InlineNotice notice={{ tone: "info", message: t("该节点还没有部署或运维任务记录。") }} />
      )}
      <div className="diagnostic-cards">
        <article>
          <small>{t("节点身份")}</small>
          <b>
            <Pill value={diagnostics.connectivity?.status || node.status} />
          </b>
          <span title={node.node_identity || undefined}>
            {node.ip}
            {node.node_identity ? ` · ID …${node.node_identity.slice(-8)}` : t(" · 等待首次身份绑定")}
          </span>
        </article>
        <article>
          <small>{t("Agent 通道")}</small>
          <b>
            <Pill value={diagnostics.connectivity?.agentChannel || "unknown"} />
          </b>
          <span>
            {t("最近心跳")} <Time value={diagnostics.connectivity?.lastAuthenticatedHeartbeat} />
          </span>
        </article>
        <article>
          <small>{t("防火墙")}</small>
          <b>{diagnostics.connectivity?.firewall.manager || "unknown"}</b>
          <span>{diagnostics.connectivity?.firewall.inputPolicy || "—"}</span>
        </article>
        <article>
          <small>{t("资源")}</small>
          <b>{node.metrics ? `CPU ${node.metrics.cpuPercent.toFixed(0)}%` : t("暂无指标")}</b>
          <span>
            {node.metrics ? t("内存 {0}% · 磁盘 {1}%", [node.metrics.memory.percent.toFixed(0), node.metrics.disk.percent.toFixed(0)]) : t("等待心跳上报")}
          </span>
        </article>
        <article title={liveRate(node) ? t("公网网卡近 30 秒平均速率") : undefined}>
          <small>{t("网速")}</small>
          <b>{liveRate(node) ? t("出 {0}", [formatRate(liveRate(node)!.tx)]) : "—"}</b>
          <span>
            {liveRate(node)
              ? t("入 {0}", [formatRate(liveRate(node)!.rx)])
              : node.status !== "online"
                ? "—"
                : outdated
                  ? t("升级 Agent 后显示")
                  : t("等待心跳上报")}
          </span>
        </article>
        <article title={node.monthlyTraffic ? t("公网网卡流量，按 UTC 自然月累计，自 {0} 起", [formatTime(node.monthlyTraffic.trackedSince)]) : undefined}>
          <small>{t("本月流量")}</small>
          <b>{node.monthlyTraffic ? t("出 {0}", [formatBytes(node.monthlyTraffic.txBytes)]) : "—"}</b>
          <span>{node.monthlyTraffic ? t("入 {0}", [formatBytes(node.monthlyTraffic.rxBytes)]) : outdated ? t("升级 Agent 后统计") : t("等待心跳上报")}</span>
        </article>
      </div>
      {diagnostics.connectivity?.note && <div className="inline-notice info">{diagnostics.connectivity.note}</div>}
      <section className="deployment-log">
        <div className="diagnostic-section-head">
          <div>
            <h3>{t("部署与操作日志")}</h3>
            <p>{t("Controller 记录的 Bootstrap、Agent 和修复任务事件，最新事件在最上方。")}</p>
          </div>
          <span>{t("{0} 条事件", [diagnostics.actionEvents.length])}</span>
        </div>
        {diagnostics.actionEvents.length ? (
          <div className="event-list">
            {diagnostics.actionEvents.slice(0, 100).map((event) => (
              <div key={event.id}>
                <time>{formatTime(event.created_at)}</time>
                <Pill value={event.level} />
                <span>
                  <b>{phaseLabel(event.phase)}</b>
                  {event.message}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t("还没有部署或操作日志。")}</Empty>
        )}
      </section>
      <section>
        <h3>{t("VPN 协议运行状态")}</h3>
        {diagnostics.connectivity?.protocols.length ? (
          <div className="protocol-grid">
            {diagnostics.connectivity.protocols.map((protocol) => (
              <article key={protocol.protocol}>
                <div>
                  <b>{protocolName(protocol.protocol)}</b>
                  <Pill value={protocol.state} />
                </div>
                <small>
                  {protocol.transport}:{protocol.port} · {protocol.listening ? t("正在监听") : t("未监听")} ·{" "}
                  {t("运行时：{0}", [protocol.runtimeActive ? t("运行中") : t("未运行")])}
                </small>
                <small>
                  {t("主机防火墙：{0}", [statusLabel(protocol.hostFirewall)])} · {t("云防火墙：{0}", [statusLabel(protocol.cloudFirewall)])}
                </small>
                {protocol.lastError && <p>{protocol.lastError}</p>}
              </article>
            ))}
          </div>
        ) : (
          <Empty>{t("没有 Agent 协议状态。")}</Empty>
        )}
      </section>
      <section>
        <h3>{t("配置同步任务")}</h3>
        {diagnostics.reconcile.tasks.length ? (
          <div className="action-list">
            {diagnostics.reconcile.tasks.slice(0, 20).map((task) => (
              <article key={task.id}>
                <div>
                  <b>
                    {protocolName(task.protocol)} · {task.taskType}
                  </b>
                  <Pill value={task.status} />
                </div>
                <small>
                  revision {task.desiredRevision} · {t("尝试 {0} 次", [task.attempts])} · <Time value={task.createdAt} />
                </small>
                {task.lastError && <p>{task.lastError}</p>}
              </article>
            ))}
          </div>
        ) : (
          <Empty>{t("没有待处理的配置同步任务。")}</Empty>
        )}
      </section>
      <section>
        <h3>{t("任务历史与原始输出")}</h3>
        {diagnostics.actions.length ? (
          <div className="operation-history-list">
            {diagnostics.actions.map((action) => (
              <details key={action.id} open={action.id === diagnostics.actions[0]?.id && action.status === "failed"}>
                <summary>
                  <span>
                    <b>{actionLabel(action.action)}</b>
                    <small>
                      {phaseLabel(action.current_phase)} · {action.progress || 0}%
                    </small>
                  </span>
                  <Pill value={action.status} />
                  <Time value={action.finished_at || action.started_at || action.created_at} />
                  <i className="chev" />
                </summary>
                <div>
                  {action.error && (
                    <>
                      <b>{t("错误")}</b>
                      <pre className="history-error">{action.error}</pre>
                    </>
                  )}
                  {action.output && (
                    <>
                      <b>{t("原始输出")}</b>
                      <pre>{action.output}</pre>
                    </>
                  )}
                  {!action.error && !action.output && <p>{t("该任务没有保存额外输出。")}</p>}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Empty>{t("没有历史任务。")}</Empty>
        )}
      </section>
    </div>
  );
}
