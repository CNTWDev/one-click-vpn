import { FleetMap } from "../fleet-map";
import type { ControllerInfo, NodeRecord, Region } from "../types";
import { PageHeader } from "./shared";

export function TopologyPage({ nodes, regions, controllerSettings, onNavigate, onRefresh }: {
  nodes: NodeRecord[]; regions: Region[]; controllerSettings?: ControllerInfo["settings"] | null; onNavigate: (page: string) => void; onRefresh: () => Promise<void>;
}) {
  return <>
    <PageHeader
      eyebrow="GLOBAL FABRIC"
      title="全球拓扑"
      description="查看 Controller 与各区域 Agent 的管理通道、节点状态和全球覆盖空白。"
      actions={<button className="button ghost" onClick={() => void onRefresh()}>刷新拓扑</button>}
    />
    <FleetMap nodes={nodes} regions={regions} controller={controllerSettings} onNavigate={onNavigate} />
    <section className="topology-notes">
      <article><span>C</span><div><b>Controller 控制面</b><small>统一下发部署、修复、配置同步和诊断任务。</small></div></article>
      <article><span>A</span><div><b>Agent 管理通道</b><small>连线表示 Controller 与节点 Agent 的控制关系，不暴露用户流量。</small></div></article>
      <article><span>E</span><div><b>Edge Node 独立承载</b><small>当前不是节点间 Mesh；VPN 用户连接由所选区域节点独立处理。</small></div></article>
    </section>
  </>;
}
