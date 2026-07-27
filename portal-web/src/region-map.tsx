import { useEffect, useMemo, useState } from "react";
import { countryMapPoints } from "./country-map-points";

export type RegionMapRegion = {
  id: string;
  name: string;
  country: string;
  code: string;
  protocols: string[];
  status: string;
  onlineNodeCount?: number;
  healthyNodeCount?: number;
  protocolNodeCounts?: Record<string, number>;
};

type MapPoint = { x: number; y: number };
type LocationState = {
  status: "unset" | "locating" | "located" | "error";
  latitude?: number;
  longitude?: number;
  message?: string;
};

function projectGeoPoint(latitude: number, longitude: number): MapPoint {
  const width = 1010;
  const scale = width / (2 * Math.PI);
  const safeLatitude = Math.max(-85, Math.min(85, latitude));
  let x = 475 + longitude * width / 360;
  while (x < 0) x += width;
  while (x > width) x -= width;
  const radians = safeLatitude * Math.PI / 180;
  const y = 462.8 - scale * Math.log(Math.tan(Math.PI / 4 + radians / 2));
  return { x, y: Math.max(10, Math.min(656, y)) };
}

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

function requestBrowserLocation(setLocation: (state: LocationState) => void) {
  if (!window.isSecureContext) {
    setLocation({ status: "error", message: "浏览器定位需要通过 HTTPS 访问 Portal。" });
    return;
  }
  if (!navigator.geolocation) {
    setLocation({ status: "error", message: "当前浏览器不支持定位。" });
    return;
  }
  setLocation({ status: "locating", message: "正在自动获取浏览器位置…" });
  navigator.geolocation.getCurrentPosition(
    (position) => setLocation({ status: "located", latitude: position.coords.latitude, longitude: position.coords.longitude, message: "已自动使用浏览器位置" }),
    (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? "未获得定位权限，可点击按钮重试。"
        : error.code === error.TIMEOUT
          ? "自动定位超时，可点击按钮重试。"
          : "无法获取当前位置，请检查系统定位服务。";
      setLocation({ status: "error", message });
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
  );
}

export function RegionMap({ regions, selectedRegionId, onSelect }: {
  regions: RegionMapRegion[];
  selectedRegionId: string;
  onSelect: (regionId: string) => void;
}) {
  const [location, setLocation] = useState<LocationState>({ status: "unset" });
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
  const hasLocation = location.status === "located" && location.latitude !== undefined && location.longitude !== undefined;
  const origin = hasLocation ? projectGeoPoint(location.latitude!, location.longitude!) : { x: 505, y: 606 };

  useEffect(() => { requestBrowserLocation(setLocation); }, []);

  function locateUser() { requestBrowserLocation(setLocation); }

  return <section className="region-map-panel">
    <div className="region-map-head">
      <div><p className="kicker">GLOBAL NETWORK</p><h2>全球可用网络</h2><p>点击地图选择区域，生成配置时会自动使用该区域。</p></div>
      <div className="region-map-summary"><span><b>{availableRegions.length}</b>可用区域</span><span><b>{protocolCount}</b>可用协议</span>{selected && <span className="selected-region"><b>{selected.code}</b>{selected.name}</span>}</div>
    </div>
    <div className="region-map-stage">
      <div className="region-map-scan" />
      <div className="region-map-location-control"><button type="button" className={`region-locate-button ${hasLocation ? "located" : ""}`} disabled={location.status === "locating"} onClick={locateUser}><span>◎</span>{location.status === "locating" ? "定位中…" : hasLocation ? "重新定位" : "定位我的位置"}</button>{location.message && <small className={`region-location-status ${location.status}`} role="status">{location.message}{hasLocation ? ` · ${location.latitude!.toFixed(2)}, ${location.longitude!.toFixed(2)}` : ""}</small>}</div>
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
        <g className={`region-map-origin ${hasLocation ? "located" : "logical"}`} transform={`translate(${origin.x} ${origin.y})`}>
          <title>{hasLocation ? `浏览器定位\n${location.latitude}, ${location.longitude}` : "逻辑入口，不代表你的真实地理位置"}</title>
          <circle className="origin-halo" r="14" /><circle className="origin-ring" r="7" /><path className="origin-core" d="M0 -4.8 L4.8 0 L0 4.8 L-4.8 0 Z" />
          <text x={origin.x > 790 ? -14 : 14} y="4" textAnchor={origin.x > 790 ? "end" : "start"}>{hasLocation ? "YOUR LOCATION" : "LOGICAL ENTRY"}</text>
        </g>
      </svg>
      {!visibleRegions.length && <div className="region-map-empty">管理员部署并启用节点后，可用区域会显示在这里。</div>}
      <div className="region-map-caption"><span>{hasLocation ? "浏览器位置 → 可用区域" : "逻辑入口 → 可用区域（未定位）"}</span><small>不代表实际公网路由或节点间直连</small></div>
      <div className="region-map-attribution">Map data · @svg-maps/world · CC BY 4.0</div>
    </div>
    <div className="region-map-footer"><div><span><i className="available" />可用</span><span><i className="selected" />已选择</span><span><i className="unavailable" />暂不可用</span></div><small>定位坐标仅在当前浏览器中用于绘图，不会上传 Controller。</small></div>
  </section>;
}
