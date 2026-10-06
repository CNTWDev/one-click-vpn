import { t, useConsoleLanguage } from "../i18n";
import { FleetMap } from "../fleet-map";
import { Icon } from "../icons";
import type { ControllerInfo, NodeRecord, Region } from "../types";
import { PageHeader } from "./shared";

export function TopologyPage({ nodes, regions, controllerSettings, onRefresh }: {
  nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onRefresh: () => Promise<void>;
}) {
  useConsoleLanguage();
  return <>
    <PageHeader title={t("全球拓扑")} description={t("Controller 与各区域 Agent 的管理通道、节点状态和覆盖空白；点击节点标记打开节点详情。")} actions={<button className="button ghost" onClick={() => void onRefresh()}><Icon name="refresh" size={16} />{t("刷新")}</button>} />
    <FleetMap nodes={nodes} regions={regions} controller={controllerSettings} />
    <section className="topology-notes">
      <article><span><Icon name="controller" /></span><div><b>{t("Controller 控制面")}</b><small>{t("统一下发部署、修复、配置同步和诊断任务。")}</small></div></article>
      <article><span><Icon name="topology" /></span><div><b>{t("Agent 管理通道")}</b><small>{t("连线表示 Controller 与节点 Agent 的控制关系，不暴露用户流量。")}</small></div></article>
      <article><span><Icon name="nodes" /></span><div><b>{t("Edge Node 独立承载")}</b><small>{t("当前不是节点间 Mesh；VPN 用户连接由所选区域节点独立处理。")}</small></div></article>
    </section>
  </>;
}
