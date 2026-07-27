import { useMemo } from "react";
import { countryMapPoints } from "../../admin-web/src/country-map-points";

export type RegionMapRegion = {
  id: string;
  name: string;
  country: string;
  code: string;
  protocols: string[];
  status: string;
  onlineNodeCount?: number;
  healthyNodeCount?: number;
};

type MapPoint = { x: number; y: number };

function pointCode(region: RegionMapRegion): string {
  const code = region.code.toUpperCase();
  if (countryMapPoints[code]) return code;
  return code.split(/[-_]/)[0];
}

function protocolLabel(protocol: string): string {
  if (protocol === "wireguard") return "WireGuard";
  if (protocol === "openvpn") return "OpenVPN";
  return protocol;
}

export function RegionMap({ regions, selectedRegionId, onSelect }: {
  regions: RegionMapRegion[];
  selectedRegionId: string;
  onSelect: (regionId: string) => void;
}) {
  const points = useMemo(() => {
    const next: Record<string, MapPoint> = {};
    const byCountry = new Map<string, RegionMapRegion[]>();
    for (const region of regions) {
      const code = pointCode(region);
      byCountry.set(code, [...(byCountry.get(code) || []), region]);
    }
    for (const [code, countryRegions] of byCountry) {
      const center = countryMapPoints[code];
      if (!center) continue;
      countryRegions.forEach((region, index) => {
        const angle = countryRegions.length > 1 ? (Math.PI * 2 * index) / countryRegions.length - Math.PI / 2 : 0;
        const radius = countryRegions.length > 1 ? Math.min(7 + countryRegions.length * 1.5, 17) : 0;
        next[region.id] = { x: center[0] + Math.cos(angle) * radius, y: center[1] + Math.sin(angle) * radius };
      });
    }
    return next;
  }, [regions]);

  const visibleRegions = regions.filter((region) => points[region.id]);
  const availableRegions = visibleRegions.filter((region) => region.status === "available");
  const selected = regions.find((region) => region.id === selectedRegionId);
  const protocolCount = new Set(availableRegions.flatMap((region) => region.protocols)).size;
  const origin = { x: 505, y: 606 };

  return <section className="region-map-panel">
    <div className="region-map-head">
      <div><p className="kicker">GLOBAL NETWORK</p><h2>全球可用网络</h2><p>点击地图选择区域，生成配置时会自动使用该区域。</p></div>
      <div className="region-map-summary"><span><b>{availableRegions.length}</b>可用区域</span><span><b>{protocolCount}</b>可用协议</span>{selected && <span className="selected-region"><b>{selected.code}</b>{selected.name}</span>}</div>
    </div>
    <div className="region-map-stage">
      <div className="region-map-scan" />
      <svg viewBox="0 0 1010 666" role="img" aria-label="Northstar 当前可用 VPN 区域地图">
        <defs>
          <linearGradient id="portal-route" x1="0" x2="1"><stop offset="0" stopColor="#6f90ff" /><stop offset="1" stopColor="#b7df5d" /></linearGradient>
          <filter id="portal-glow" x="-200%" y="-200%" width="400%" height="400%"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <rect className="region-map-ocean" x="0" y="0" width="1010" height="666" />
        <image className="region-map-base" href="/world-map.webp" x="0" y="0" width="1010" height="666" />
        <g className="region-map-routes">{availableRegions.map((region, index) => {
          const point = points[region.id];
          const selectedRoute = region.id === selectedRegionId;
          const bend = Math.max(point.y, origin.y) + 20 + (index % 3) * 8;
          return <path key={`route-${region.id}`} className={selectedRoute ? "selected" : ""} d={`M${origin.x} ${origin.y} Q ${(origin.x + point.x) / 2} ${bend} ${point.x} ${point.y}`} />;
        })}</g>
        <g className="region-map-origin" transform={`translate(${origin.x} ${origin.y})`}><circle className="origin-halo" r="14" /><circle className="origin-core" r="4" /><text x="0" y="24" textAnchor="middle">YOUR DEVICE</text></g>
        <g>{visibleRegions.map((region) => {
          const point = points[region.id];
          const available = region.status === "available";
          const selectedMarker = region.id === selectedRegionId;
          const labelOnLeft = point.x > 790;
          const details = region.protocols.map(protocolLabel).join(" / ") || "当前无健康协议";
          return <g
            key={region.id}
            className={`region-map-marker ${available ? "available" : "unavailable"} ${selectedMarker ? "selected" : ""}`}
            transform={`translate(${point.x} ${point.y})`}
            role="button"
            tabIndex={0}
            aria-pressed={selectedMarker}
            aria-label={`${region.name}，${available ? "可用" : "暂不可用"}，${details}`}
            onClick={() => available && onSelect(region.id)}
            onKeyDown={(event) => { if (available && (event.key === "Enter" || event.key === " ")) onSelect(region.id); }}
          >
            <title>{`${region.name} · ${region.country}\n${details}\n${region.healthyNodeCount || 0} 个健康节点`}</title>
            <circle className="marker-pulse" r="13" /><circle className="marker-ring" r="8" /><circle className="marker-core" r="3.2" />
            <text className="marker-label" x={labelOnLeft ? -13 : 13} y="4" textAnchor={labelOnLeft ? "end" : "start"}>{region.name}</text>
          </g>;
        })}</g>
      </svg>
      {!visibleRegions.length && <div className="region-map-empty">管理员部署并启用节点后，可用区域会显示在这里。</div>}
      <div className="region-map-caption"><span>逻辑连接：你的设备 → 可用区域</span><small>不代表实际公网路由或节点间直连</small></div>
      <div className="region-map-attribution">Map data · @svg-maps/world · CC BY 4.0</div>
    </div>
    <div className="region-map-footer"><div><span><i className="available" />可用</span><span><i className="selected" />已选择</span><span><i className="unavailable" />暂不可用</span></div><small>出于安全考虑，Portal 不展示节点 IP 和 Agent 管理拓扑。</small></div>
  </section>;
}
