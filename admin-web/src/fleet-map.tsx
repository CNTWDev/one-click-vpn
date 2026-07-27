import { useMemo } from "react";
import { countryMapPoints } from "./country-map-points";
import type { NodeRecord, Region } from "./types";

type MapPoint = { x: number; y: number };
type RegionCluster = { region: Region; nodes: NodeRecord[]; status: "online" | "provisioning" | "attention" };

const coverageTargets = [
  { name: "新加坡", detail: "东南亚枢纽", codes: ["SG", "MY"] },
  { name: "东京", detail: "东北亚枢纽", codes: ["JP", "KR"] },
  { name: "法兰克福", detail: "欧洲中部", codes: ["DE", "NL", "CH"] },
  { name: "洛杉矶", detail: "北美西部", codes: ["US"] },
  { name: "悉尼", detail: "大洋洲", codes: ["AU", "NZ"] },
  { name: "圣保罗", detail: "南美洲", codes: ["BR", "CL", "AR"] },
  { name: "约翰内斯堡", detail: "非洲南部", codes: ["ZA"] },
  { name: "迪拜", detail: "中东", codes: ["AE", "BH", "QA"] },
];

function clusterStatus(nodes: NodeRecord[]): RegionCluster["status"] {
  if (nodes.some((node) => node.status === "provisioning")) return "provisioning";
  if (nodes.every((node) => node.status === "online")) return "online";
  return "attention";
}

export function FleetMap({ nodes, regions, onNavigate }: { nodes: NodeRecord[]; regions: Region[]; onNavigate: (page: string) => void }) {
  const regionMap = useMemo(() => new Map(regions.map((region) => [region.id, region])), [regions]);
  const clusters = useMemo(() => {
    const grouped = new Map<string, NodeRecord[]>();
    for (const node of nodes) {
      if (!node.region_id || !regionMap.has(node.region_id)) continue;
      grouped.set(node.region_id, [...(grouped.get(node.region_id) || []), node]);
    }
    return [...grouped.entries()].map(([regionId, regionNodes]) => ({ region: regionMap.get(regionId)!, nodes: regionNodes, status: clusterStatus(regionNodes) }));
  }, [nodes, regionMap]);

  const points = useMemo(() => {
    const next: Record<string, MapPoint> = {};
    const byCountry = new Map<string, RegionCluster[]>();
    for (const cluster of clusters) {
      const code = cluster.region.code.toUpperCase();
      byCountry.set(code, [...(byCountry.get(code) || []), cluster]);
    }
    for (const [code, countryClusters] of byCountry) {
      const center = countryMapPoints[code];
      if (!center) continue;
      countryClusters.forEach((cluster, index) => {
        const angle = countryClusters.length > 1 ? (Math.PI * 2 * index) / countryClusters.length - Math.PI / 2 : 0;
        const radius = countryClusters.length > 1 ? Math.min(6 + countryClusters.length * 1.5, 16) : 0;
        next[cluster.region.id] = { x: center[0] + Math.cos(angle) * radius, y: center[1] + Math.sin(angle) * radius };
      });
    }
    return next;
  }, [clusters]);

  const visibleClusters = clusters.filter((cluster) => points[cluster.region.id]);
  const coveredCodes = new Set(clusters.map((cluster) => cluster.region.code.toUpperCase()));
  const gaps = coverageTargets.filter((target) => !target.codes.some((code) => coveredCodes.has(code))).slice(0, 4);
  const online = nodes.filter((node) => node.status === "online").length;
  const control = { x: 78, y: 58 };

  return <section className="fleet-map-panel">
    <div className="fleet-map-head"><div><p className="eyebrow">GLOBAL FABRIC</p><h2>全球节点态势</h2><p>按区域聚合 Edge Node，点击节点标记进入运维。</p></div><div className="fleet-map-stats"><span><b>{clusters.length}</b>覆盖区域</span><span><b>{online}/{nodes.length}</b>节点在线</span><button className="text-button" onClick={() => onNavigate("regions")}>管理区域 →</button></div></div>
    <div className="fleet-map-stage">
      <div className="fleet-map-scan" />
      <svg viewBox="0 0 1010 666" role="img" aria-label="Northstar 全球 VPN 节点分布图">
        <defs>
          <linearGradient id="northstar-route-online" x1="0" x2="1"><stop offset="0" stopColor="#5f83ff" /><stop offset="1" stopColor="#b9ef69" /></linearGradient>
          <filter id="northstar-glow" x="-200%" y="-200%" width="400%" height="400%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect className="fleet-map-ocean" x="0" y="0" width="1010" height="666" />
        <image className="fleet-map-base" href="/world-map.webp" x="0" y="0" width="1010" height="666" />
        <g className="fleet-map-routes">{visibleClusters.map((cluster, index) => { const point = points[cluster.region.id]; const bend = Math.min(control.y, point.y) - 24 - (index % 3) * 8; return <path key={`route-${cluster.region.id}`} className={cluster.status} d={`M${control.x} ${control.y} Q ${(control.x + point.x) / 2} ${bend} ${point.x} ${point.y}`} />; })}</g>
        <g className="fleet-map-control" transform={`translate(${control.x} ${control.y})`}><circle className="control-halo" r="13" /><circle className="control-core" r="4" /><text x="18" y="4">CONTROL PLANE</text></g>
        <g className="fleet-map-markers">{visibleClusters.map((cluster) => { const point = points[cluster.region.id]; const onlineCount = cluster.nodes.filter((node) => node.status === "online").length; const labelOnLeft = point.x > 780; return <g key={cluster.region.id} className={`fleet-map-marker ${cluster.status}`} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`${cluster.region.name}，${cluster.nodes.length} 个节点，${onlineCount} 个在线`} onClick={() => onNavigate("nodes")} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onNavigate("nodes"); }}><title>{`${cluster.region.name} · ${cluster.region.country}\n${cluster.nodes.map((node) => `${node.name}: ${node.status}`).join("\n")}`}</title><circle className="marker-pulse" r="13" /><circle className="marker-ring" r="8" /><circle className="marker-core" r="3.2" />{cluster.nodes.length > 1 && <><circle className="marker-count-bg" cx="8" cy="-8" r="6" /><text className="marker-count" x="8" y="-5.6" textAnchor="middle">{cluster.nodes.length}</text></>}<text className="marker-label" x={labelOnLeft ? -13 : 13} y="4" textAnchor={labelOnLeft ? "end" : "start"}>{cluster.region.name}</text></g>; })}</g>
      </svg>
      {!visibleClusters.length && <div className="fleet-map-empty">创建区域并部署节点后，全球分布会显示在这里。</div>}
      <div className="fleet-map-caption"><span>动态连线：Agent 管理通道</span><small>不代表用户 VPN 流量路径</small></div>
      <div className="fleet-map-attribution">Map data · @svg-maps/world · CC BY 4.0</div>
    </div>
    <div className="fleet-map-footer"><div className="fleet-map-legend"><span><i className="online" />在线</span><span><i className="provisioning" />部署中</span><span><i className="attention" />需关注</span></div><div className="coverage-gaps"><b>{gaps.length ? "基础覆盖空白" : "基础全球覆盖已齐备"}</b>{gaps.length ? gaps.map((gap) => <button key={gap.name} onClick={() => onNavigate("regions")}><span>＋ {gap.name}</span><small>{gap.detail}</small></button>) : <small>可结合用户位置与延迟继续扩容。</small>}</div></div>
  </section>;
}
