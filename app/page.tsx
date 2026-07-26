"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import worldMap from "@svg-maps/world";
import { x25519 } from "@noble/curves/ed25519.js";
import { ConfirmDialog } from "./ConfirmDialog";

type NodeStatus = "online" | "provisioning" | "attention";

type Node = {
  id: string;
  name: string;
  place: string;
  regionId: string;
  ip: string;
  status: NodeStatus;
  latency: string;
  users: number;
  traffic: string;
  version: string;
  lastSeen: string;
  hostFingerprint?: string | null;
  sshUser?: string;
  serverPublicKey?: string | null;
  metrics?: NodeMetrics | null;
};

type NodeMetrics = {
  collectedAt: string;
  cpuPercent: number;
  load1: number;
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number };
  network: { rxBytes: number; txBytes: number; rxBytesPerSecond: number; txBytesPerSecond: number };
};

type AccessDevice = { id: string; displayName: string; platform: string; publicKey: string; status: string };
type AccessProfile = {
  id: string;
  endpoint: { host: string; port: number };
  clientAddress: string | null;
  dns: string[];
  allowedIps: string[];
  protocolPayload: { serverPublicKey?: string };
};

type Region = {
  id: string;
  name: string;
  country: string;
  code: string;
};

type NodeAction = {
  id: string;
  action: string;
  status: string;
  output: string;
  error: string;
  created_at: string;
  finished_at: string | null;
};

type ReconcileTask = {
  id: string;
  protocol: string;
  taskType: string;
  desiredRevision: number;
  status: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt?: string | null;
};

type NodeDiagnostics = {
  actions: NodeAction[];
  reconcile: {
    observed: Array<{ protocol: string; appliedRevision: number; status: string; lastError: string; updatedAt: string }>;
    tasks: ReconcileTask[];
  };
};

type NodeOperation = "status-agent" | "restart-agent" | "bootstrap" | "delete";

type PendingNodeConfirmation = {
  node: Node;
  action: Exclude<NodeOperation, "status-agent">;
  title: string;
  description: string;
  confirmLabel: string;
  tone: "warning" | "danger";
};

const initialNodes: Node[] = [
  {
    id: "fra-01",
    name: "Frankfurt Edge",
    place: "Frankfurt · Germany",
    regionId: "frankfurt-de",
    ip: "89.46.92.18",
    status: "online",
    latency: "112 ms",
    users: 24,
    traffic: "1.8 TB",
    version: "agent 1.4.0",
    lastSeen: "now",
  },
  {
    id: "tyo-01",
    name: "Tokyo Edge",
    place: "Tokyo · Japan",
    regionId: "tokyo-jp",
    ip: "160.16.74.201",
    status: "online",
    latency: "46 ms",
    users: 38,
    traffic: "2.3 TB",
    version: "agent 1.4.0",
    lastSeen: "now",
  },
  {
    id: "lax-01",
    name: "Los Angeles Edge",
    place: "Los Angeles · USA",
    regionId: "los-angeles-us",
    ip: "104.248.61.60",
    status: "attention",
    latency: "178 ms",
    users: 12,
    traffic: "684 GB",
    version: "agent 1.3.8",
    lastSeen: "8 min ago",
  },
];

const navItems = [
  ["Overview", "⌘"],
  ["Nodes", "◉"],
  ["Regions", "⌖"],
  ["Access", "⌁"],
  ["Sessions", "▣"],
  ["Audit", "◌"],
];

const fingerprintCommand = "sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256";

function StatusPill({ status }: { status: NodeStatus }) {
  const labels = {
    online: "Healthy",
    provisioning: "Deploying",
    attention: "Needs attention",
  };

  return (
    <span className={`status status-${status}`}>
      <i />
      {labels[status]}
    </span>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount < 10 && unit > 0 ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function buildWireGuardConfig(profile: AccessProfile, privateKey: string): string {
  const serverPublicKey = profile.protocolPayload.serverPublicKey;
  if (!serverPublicKey || !profile.clientAddress) throw new Error("The selected node has not reported its WireGuard server key yet.");
  return `[Interface]\nPrivateKey = ${privateKey}\nAddress = ${profile.clientAddress}/32\nDNS = ${profile.dns.join(", ")}\n\n[Peer]\nPublicKey = ${serverPublicKey}\nEndpoint = ${profile.endpoint.host}:${profile.endpoint.port}\nAllowedIPs = ${profile.allowedIps.join(", ")}\nPersistentKeepalive = 25\n`;
}

function ResourceMetrics({ metrics }: { metrics?: NodeMetrics | null }) {
  if (!metrics) return <p className="diagnostics-empty">Resource metrics are waiting for the first Agent heartbeat.</p>;
  const metricClass = (value: number) => value >= 90 ? "metric-danger" : value >= 75 ? "metric-warning" : "";
  return <>
    <div className="resource-grid">
      <div className={metricClass(metrics.cpuPercent)}><span>CPU</span><b>{metrics.cpuPercent.toFixed(1)}%</b><small>load {metrics.load1.toFixed(2)}</small></div>
      <div className={metricClass(metrics.memory.percent)}><span>MEMORY</span><b>{metrics.memory.percent.toFixed(1)}%</b><small>{formatBytes(metrics.memory.usedBytes)} / {formatBytes(metrics.memory.totalBytes)}</small></div>
      <div className={metricClass(metrics.disk.percent)}><span>DISK</span><b>{metrics.disk.percent.toFixed(1)}%</b><small>{formatBytes(metrics.disk.usedBytes)} / {formatBytes(metrics.disk.totalBytes)}</small></div>
      <div><span>NETWORK</span><b>↓ {formatBytes(metrics.network.rxBytesPerSecond)}/s</b><small>↑ {formatBytes(metrics.network.txBytesPerSecond)}/s</small></div>
    </div>
    <p className="metrics-fresh">Last collected {metrics.collectedAt} · Agent heartbeat</p>
  </>;
}

const mapPins = [
  { match: "frankfurt", x: 529, y: 281 },
  { match: "tokyo", x: 899, y: 332 },
  { match: "los angeles", x: 174, y: 338 },
  { match: "singapore", x: 798, y: 455 },
];
const worldLocations = worldMap.locations as Array<{ id: string; name: string; path: string }>;

function pinForNode(node: Node) {
  const place = `${node.name} ${node.place}`.toLowerCase();
  return mapPins.find((pin) => place.includes(pin.match)) || null;
}

function WorldMap({ nodes }: { nodes: Node[] }) {
  const pins = nodes.map((node) => ({ node, pin: pinForNode(node) })).filter((item): item is { node: Node; pin: { match: string; x: number; y: number } } => Boolean(item.pin));

  return (
    <div className="world-map">
      <svg className="map-svg" viewBox={worldMap.viewBox} role="img" aria-label="World map showing Northstar edge nodes">
        <rect className="map-ocean" x="0" y="0" width="1010" height="666" />
        <g className="map-graticule"><path d="M0 333H1010M505 0V666" /><ellipse cx="505" cy="333" rx="337" ry="222" /></g>
        <g className="map-land">{worldLocations.map((location) => <path key={location.id} d={location.path} aria-label={location.name}><title>{location.name}</title></path>)}</g>
        <g className="map-routes">{pins.map(({ node, pin }) => <path key={`route-${node.id}`} d={`M520 235 Q ${(520 + pin.x) / 2} ${(235 + pin.y) / 2 - 45} ${pin.x} ${pin.y}`} />)}</g>
        <g className="map-control" transform="translate(520 235)"><circle r="9" /><circle className="map-marker-core" r="3" /><text x="13" y="4">CONTROL</text></g>
        <g className="map-markers">{pins.map(({ node, pin }) => <g key={node.id} className={`map-marker map-marker-${node.status}`} transform={`translate(${pin.x} ${pin.y})`}><title>{`${node.name} · ${node.place}`}</title><circle className="map-marker-halo" r="11" /><circle className="map-marker-core" r="4" /><text x="12" y="4">{node.name}</text></g>)}</g>
      </svg>
      <div className="map-caption">{nodes.length} edge nodes · {pins.length} shown on map</div>
      <div className="map-attribution">Map data: <a href="https://github.com/VictorCazanave/svg-maps" target="_blank" rel="noreferrer">@svg-maps/world</a> · CC BY 4.0</div>
    </div>
  );
}

function NodeFleet({
  nodes,
  regions,
  onRefresh,
  onOpenTerminal,
  onEditNode,
  onNodeAction,
  busyNodeAction,
}: {
  nodes: Node[];
  regions: Region[];
  onRefresh: () => void;
  onOpenTerminal: (node: Node) => void;
  onEditNode: (node: Node) => void;
  onNodeAction: (node: Node, action: NodeOperation) => void;
  busyNodeAction: string | null;
}) {
  const [regionId, setRegionId] = useState("all");
  const visibleNodes = regionId === "all" ? nodes : nodes.filter((node) => node.regionId === regionId);
  const selectedRegion = regions.find((region) => region.id === regionId);

  return (
    <section className="nodes-section">
      <div className="section-title nodes-title"><div><p>EDGE NODES</p><h2>Fleet status</h2></div><div className="node-toolbar"><select className="filter-button" aria-label="Filter nodes by region" value={regionId} onChange={(event) => setRegionId(event.target.value)}><option value="all">All regions</option>{regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select><button className="plain-action" type="button" onClick={onRefresh}>Refresh <span>↻</span></button></div></div>
      <div className="node-list">
        <div className="node-head"><span>NODE</span><span>STATUS</span><span>LATENCY</span><span>DEVICES</span><span>TRAFFIC</span><span /></div>
        {visibleNodes.length === 0 ? <div className="empty-state"><b>{nodes.length === 0 ? "No managed nodes yet" : `No nodes in ${selectedRegion?.name || "this region"}`}</b><span>{nodes.length === 0 ? "Add a VPN node to start monitoring the fleet." : "Choose another region or add a node to this region."}</span></div> : visibleNodes.map((node) => (
          <article className="node-row" key={node.id}>
            <div className="node-name"><span className="flag">{node.place.includes("Germany") ? "DE" : node.place.includes("Japan") ? "JP" : node.place.includes("USA") ? "US" : "●"}</span><div><b>{node.name}</b><small>{node.place} · {node.ip}</small></div></div>
            <StatusPill status={node.status} />
            <div className={node.status === "attention" ? "node-value danger" : "node-value"}>{node.latency}<small>{node.metrics ? `CPU ${node.metrics.cpuPercent.toFixed(0)}% · RAM ${node.metrics.memory.percent.toFixed(0)}%` : `last seen ${node.lastSeen}`}</small></div>
            <div className="node-value">{node.users}<small>authorized</small></div>
            <div className="node-value">{node.traffic}<small>{node.version}</small></div>
            <div className="row-actions">
              <button className="quick-action" type="button" disabled={busyNodeAction === `${node.id}:status-agent`} onClick={() => onNodeAction(node, "status-agent")}>{busyNodeAction === `${node.id}:status-agent` ? "Checking…" : "Check"}</button>
              <details className="node-action-menu">
                <summary>Actions</summary>
                <div className="node-action-popover">
                  <button type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onNodeAction(node, "status-agent"); }}>Check agent</button>
                  <button type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onNodeAction(node, "restart-agent"); }}>Restart agent</button>
                  <button type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onNodeAction(node, "bootstrap"); }}>Reinstall agent</button>
                  <button type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onOpenTerminal(node); }}>View logs</button>
                  <button type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onEditNode(node); }}>Edit configuration</button>
                  <button className="menu-danger" type="button" disabled={Boolean(busyNodeAction)} onClick={(event) => { (event.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); onNodeAction(node, "delete"); }}>Delete node</button>
                </div>
              </details>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [authStatus, setAuthStatus] = useState<"loading" | "signed-out" | "signed-in">("loading");
  const [user, setUser] = useState<{ displayName: string; email: string } | null>(null);
  const [login, setLogin] = useState({ email: "", password: "" });
  const [loginBusy, setLoginBusy] = useState(false);
  const [activeNav, setActiveNav] = useState("Overview");
  const [showDeploy, setShowDeploy] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [nodeDiagnostics, setNodeDiagnostics] = useState<NodeDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState("");
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [nodeActionBusy, setNodeActionBusy] = useState<string | null>(null);
  const [pendingNodeConfirmation, setPendingNodeConfirmation] = useState<PendingNodeConfirmation | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node>(initialNodes[0]);
  const [notice, setNotice] = useState("All systems nominal");
  const [form, setForm] = useState({ name: "", ip: "", user: "root", secret: "", regionId: "tokyo-jp", hostFingerprint: "" });
  const [regionForm, setRegionForm] = useState({ name: "", country: "", code: "" });
  const [editingRegionId, setEditingRegionId] = useState<string | null>(null);
  const [regionBusy, setRegionBusy] = useState(false);
  const [showFingerprintGuide, setShowFingerprintGuide] = useState(false);
  const [fingerprintCommandCopied, setFingerprintCommandCopied] = useState(false);
  const [accessDevices, setAccessDevices] = useState<AccessDevice[]>([]);
  const [accessNodeId, setAccessNodeId] = useState("");
  const [accessDeviceName, setAccessDeviceName] = useState("My Mac");
  const [accessDeviceBusy, setAccessDeviceBusy] = useState<string | null>(null);
  const [pendingDeviceRevocation, setPendingDeviceRevocation] = useState<AccessDevice | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [accessConfig, setAccessConfig] = useState<{ name: string; config: string } | null>(null);

  const loadNodes = useCallback(async () => {
    const response = await fetch("/api/nodes", { cache: "no-store" });
    if (response.status === 401) {
      setAuthStatus("signed-out");
      return;
    }
    const payload = await response.json() as { nodes: Array<Record<string, unknown>> };
    setNodes(payload.nodes.map((node) => ({
      id: String(node.id),
      name: String(node.name),
      place: String(node.place),
      ip: String(node.ip),
      status: node.status === "online" ? "online" : node.status === "provisioning" ? "provisioning" : "attention",
      regionId: String(node.region_id || ""),
      latency: String(node.latency),
      users: Number(node.users || 0),
      traffic: String(node.traffic || "—"),
      version: String(node.version || "unknown"),
      lastSeen: String(node.last_seen || "never"),
      hostFingerprint: typeof node.host_fingerprint === "string" ? node.host_fingerprint : null,
      sshUser: String(node.ssh_user || "root"),
      serverPublicKey: typeof node.server_public_key === "string" ? node.server_public_key : null,
      metrics: node.metrics && typeof node.metrics === "object" ? node.metrics as NodeMetrics : null,
    })));
  }, []);

  const loadRegions = useCallback(async () => {
    const response = await fetch("/api/regions", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { regions: Region[] };
    setRegions(payload.regions);
    setForm((current) => ({ ...current, regionId: payload.regions.some((region) => region.id === current.regionId) ? current.regionId : payload.regions[0]?.id || "" }));
  }, []);

  const loadAccessDevices = useCallback(async () => {
    const response = await fetch("/api/access/devices", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { devices?: AccessDevice[] };
    setAccessDevices(payload.devices || []);
  }, []);

  const loadNodeDiagnostics = useCallback(async (nodeId: string) => {
    setDiagnosticsBusy(true);
    try {
      const response = await fetch(`/api/nodes/${nodeId}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { node?: Partial<Node>; actions?: NodeAction[]; reconcile?: NodeDiagnostics["reconcile"] };
      if (payload.node) setSelectedNode((current) => ({ ...current, ...payload.node }));
      setNodeDiagnostics({ actions: payload.actions || [], reconcile: payload.reconcile || { observed: [], tasks: [] } });
    } finally {
      setDiagnosticsBusy(false);
    }
  }, []);

  useEffect(() => {
    void fetch("/api/auth/me", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) {
        setAuthStatus("signed-out");
        return;
      }
      const payload = await response.json() as { user: { displayName: string; email: string } };
      setUser(payload.user);
      setAuthStatus("signed-in");
      await Promise.all([loadNodes(), loadRegions()]);
    }).catch(() => setAuthStatus("signed-out"));
  }, [loadNodes, loadRegions]);

  useEffect(() => {
    if (authStatus !== "signed-in") return undefined;
    const timer = window.setInterval(() => { void loadNodes(); }, 5000);
    return () => window.clearInterval(timer);
  }, [authStatus, loadNodes]);

  useEffect(() => {
    if (authStatus !== "signed-in" || activeNav !== "Access") return undefined;
    const timer = window.setTimeout(() => void loadAccessDevices(), 0);
    return () => window.clearTimeout(timer);
  }, [activeNav, authStatus, loadAccessDevices]);

  useEffect(() => {
    if (!showTerminal || !selectedNode) return undefined;
    const timer = window.setInterval(() => { void loadNodeDiagnostics(selectedNode.id); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadNodeDiagnostics, selectedNode, showTerminal]);

  const totalUsers = useMemo(() => nodes.reduce((sum, node) => sum + node.users, 0), [nodes]);
  const healthyNodes = nodes.filter((node) => node.status === "online").length;
  const attentionNodes = nodes.filter((node) => node.status === "attention").length;

  function openTerminal(node: Node) {
    setSelectedNode(node);
    setNodeDiagnostics(null);
    setShowTerminal(true);
    void loadNodeDiagnostics(node.id);
  }

  function openAddNode() {
    setEditingNodeId(null);
    setDeployError("");
    setForm({ name: "", ip: "", user: "root", secret: "", regionId: regions[0]?.id || "", hostFingerprint: "" });
    setShowDeploy(true);
  }

  function openEditNode(node: Node) {
    setEditingNodeId(node.id);
    setDeployError("");
    setForm({ name: node.name, ip: node.ip, user: node.sshUser || "root", secret: "", regionId: node.regionId, hostFingerprint: node.hostFingerprint || "" });
    setShowDeploy(true);
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(login) });
    const payload = await response.json().catch(() => ({})) as { error?: string; user?: { displayName: string; email: string } };
    if (!response.ok || !payload.user) {
      setNotice(payload.error || "Unable to sign in");
      setLoginBusy(false);
      return;
    }
    setUser(payload.user);
    setAuthStatus("signed-in");
    setLogin({ email: "", password: "" });
    setLoginBusy(false);
    await Promise.all([loadNodes(), loadRegions()]);
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setNodes([]);
    setAuthStatus("signed-out");
  }

  async function createMacAccessProfile() {
    const node = nodes.find((item) => item.id === accessNodeId && item.status === "online") || nodes.find((item) => item.status === "online");
    if (!node) {
      setAccessError("Add and bootstrap at least one healthy node first.");
      return;
    }
    if (!node.serverPublicKey) {
      setAccessError("This node has not reported a WireGuard server key yet. Reinstall or restart its Agent, then wait for the next heartbeat.");
      return;
    }
    setAccessBusy(true);
    setAccessError("");
    setAccessConfig(null);
    try {
      const privateBytes = x25519.utils.randomSecretKey();
      const privateKey = base64(privateBytes);
      const publicKey = base64(x25519.getPublicKey(privateBytes));
      const deviceResponse = await fetch("/api/access/devices", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: accessDeviceName.trim() || "My Mac", platform: "macos", publicKey }),
      });
      const devicePayload = await deviceResponse.json().catch(() => ({})) as { device?: AccessDevice; error?: string };
      if (!deviceResponse.ok || !devicePayload.device) throw new Error(devicePayload.error || "Unable to register this Mac");
      setAccessDevices((current) => [devicePayload.device!, ...current]);
      const profileResponse = await fetch("/api/access/profiles", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: devicePayload.device.id, nodeId: node.id }),
      });
      const profilePayload = await profileResponse.json().catch(() => ({})) as { profile?: AccessProfile; error?: string };
      if (!profileResponse.ok || !profilePayload.profile) throw new Error(profilePayload.error || "Unable to create a connection profile");
      const activateResponse = await fetch(`/api/access/profiles/${profilePayload.profile.id}/activate`, { method: "POST" });
      const activatePayload = await activateResponse.json().catch(() => ({})) as { profile?: AccessProfile; error?: string };
      if (!activateResponse.ok || !activatePayload.profile) throw new Error(activatePayload.error || "Unable to activate the connection profile");
      setAccessConfig({ name: `${node.name.replaceAll(/[^A-Za-z0-9_-]+/g, "-")}.conf`, config: buildWireGuardConfig(activatePayload.profile, privateKey) });
      setNotice(`${node.name} connection profile is ready. Download it and import it into WireGuard.`);
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Unable to prepare the Mac connection");
    } finally {
      setAccessBusy(false);
    }
  }

  function downloadAccessConfig() {
    if (!accessConfig) return;
    const url = URL.createObjectURL(new Blob([accessConfig.config], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = accessConfig.name;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function revokeAccessDevice(device: AccessDevice) {
    setAccessDeviceBusy(device.id);
    try {
      const response = await fetch(`/api/access/devices/${device.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({})) as { device?: AccessDevice; error?: string };
      if (!response.ok || !payload.device) throw new Error(payload.error || "Unable to revoke the device");
      setAccessDevices((current) => current.map((item) => item.id === device.id ? payload.device! : item));
      setNotice(`${device.displayName} was revoked and removed from the VPN configuration.`);
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "Unable to revoke the device");
    } finally {
      setAccessDeviceBusy(null);
      setPendingDeviceRevocation(null);
    }
  }

  async function deployNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeployError("");
    const editing = Boolean(editingNodeId);
    if (!form.name || !form.ip || (!editing && !form.secret)) {
      const message = editing ? "Complete the node name and public IP." : "Complete the node name, public IP, and SSH credential.";
      setDeployError(message);
      setNotice(message);
      return;
    }

    setDeploying(true);
    setNotice(editing ? "Saving node configuration…" : "Verifying SSH host key and preparing a signed deployment task…");
    const response = await fetch(editing ? `/api/nodes/${editingNodeId}` : "/api/nodes", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: form.name, ip: form.ip, regionId: form.regionId, sshUser: form.user, secret: form.secret, hostFingerprint: form.hostFingerprint,
    }) });
    const payload = await response.json().catch(() => ({})) as { error?: string; node?: Node };
    setDeploying(false);
    if (!response.ok || !payload.node) {
      const message = payload.error || (editing ? "Unable to update node" : "Unable to create node");
      setDeployError(message);
      setNotice(message);
      return;
    }
    setNodes((current) => editing ? current.map((node) => node.id === payload.node!.id ? payload.node! : node) : [payload.node!, ...current]);
    if (editing && selectedNode.id === payload.node.id) setSelectedNode(payload.node);
    setShowDeploy(false);
    setEditingNodeId(null);
    setDeployError("");
    setForm({ name: "", ip: "", user: "root", secret: "", regionId: regions[0]?.id || "", hostFingerprint: "" });
    setNotice(editing ? `${payload.node.name} configuration saved.` : `${payload.node.name} is queued for secure bootstrap. The credential is encrypted server-side.`);
  }

  async function copyFingerprintCommand() {
    try {
      await navigator.clipboard.writeText(fingerprintCommand);
      setFingerprintCommandCopied(true);
      window.setTimeout(() => setFingerprintCommandCopied(false), 1800);
    } catch {
      setNotice("Clipboard access is unavailable; please copy the command manually.");
    }
  }

  async function saveRegion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRegionBusy(true);
    const editing = Boolean(editingRegionId);
    const response = await fetch(editing ? `/api/regions/${editingRegionId}` : "/api/regions", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(regionForm),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; region?: Region };
    setRegionBusy(false);
    if (!response.ok || !payload.region) {
      setNotice(payload.error || "Unable to save region");
      return;
    }
    setRegions((current) => editing ? current.map((region) => region.id === payload.region!.id ? payload.region! : region) : [...current, payload.region!]);
    setRegionForm({ name: "", country: "", code: "" });
    setEditingRegionId(null);
    setNotice(`${payload.region.name} region saved.`);
    await loadNodes();
  }

  function editRegion(region: Region) {
    setEditingRegionId(region.id);
    setRegionForm({ name: region.name, country: region.country, code: region.code });
  }

  async function removeRegion(region: Region) {
    const response = await fetch(`/api/regions/${region.id}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setNotice(payload.error || "Unable to delete region");
      return;
    }
    setRegions((current) => current.filter((item) => item.id !== region.id));
    setForm((current) => current.regionId === region.id ? { ...current, regionId: regions.find((item) => item.id !== region.id)?.id || "" } : current);
    setNotice(`${region.name} region deleted.`);
  }

  async function executeNodeAction(node: Node, action: NodeOperation) {
    if (nodeActionBusy) return;
    setNodeActionBusy(`${node.id}:${action}`);
    try {
      let response: Response;
      if (action === "delete") {
        response = await fetch(`/api/nodes/${node.id}`, { method: "DELETE" });
      } else if (action === "bootstrap") {
        response = await fetch(`/api/nodes/${node.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "bootstrap" }) });
      } else {
        response = await fetch(`/api/nodes/${node.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      }
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setNotice(payload.error || `${action} failed.`);
        return;
      }
      if (action === "delete") {
        setNodes((current) => current.filter((item) => item.id !== node.id));
        if (selectedNode.id === node.id) {
          setNodeDiagnostics(null);
          setShowTerminal(false);
        }
        setNotice(`${node.name} deleted from the controller.`);
        return;
      }
      const labels: Record<Exclude<NodeOperation, "delete">, string> = {
        "status-agent": "Agent check completed",
        "restart-agent": "Agent restart completed",
        bootstrap: "Agent reinstall queued",
      };
      setNotice(`${labels[action]} for ${node.name}.`);
      await loadNodes();
      if (showTerminal && selectedNode.id === node.id) await loadNodeDiagnostics(node.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Node operation failed.");
    } finally {
      setNodeActionBusy(null);
    }
  }

  function requestNodeAction(node: Node, action: NodeOperation) {
    if (action === "status-agent") {
      void executeNodeAction(node, action);
      return;
    }
    const confirmations: Record<Exclude<NodeOperation, "status-agent">, Omit<PendingNodeConfirmation, "node" | "action">> = {
      "restart-agent": {
        title: `Restart ${node.name}'s agent?`,
        description: "The remote Agent service will restart. Active VPN sessions may be interrupted briefly while the node reconnects.",
        confirmLabel: "Restart agent",
        tone: "warning",
      },
      bootstrap: {
        title: `Reinstall ${node.name}'s agent?`,
        description: "This will reconnect over SSH, overwrite the remote Agent files, and restart the node service. Existing VPN configuration is not intentionally deleted.",
        confirmLabel: "Reinstall agent",
        tone: "warning",
      },
      delete: {
        title: `Delete ${node.name}?`,
        description: "This removes the node from the controller. It does not uninstall the remote Agent or close the cloud firewall, so the node must be cleaned up separately.",
        confirmLabel: "Delete node",
        tone: "danger",
      },
    };
    setPendingNodeConfirmation({ node, action, ...confirmations[action] });
  }

  async function confirmNodeAction() {
    if (!pendingNodeConfirmation) return;
    await executeNodeAction(pendingNodeConfirmation.node, pendingNodeConfirmation.action);
    setPendingNodeConfirmation(null);
  }

  if (authStatus === "loading") {
    return <main className="auth-screen"><div className="auth-card"><span className="brand-mark"><i /><i /><i /></span><p className="eyebrow"><span /> NORTHSTAR</p><h1>Loading control plane…</h1></div></main>;
  }

  if (authStatus === "signed-out") {
    return <main className="auth-screen"><form className="auth-card" onSubmit={signIn}>
      <span className="brand-mark"><i /><i /><i /></span><p className="eyebrow"><span /> SECURE CONTROL PLANE</p><h1>Sign in to Northstar.</h1><p className="auth-copy">Use the owner account configured on the controller host.</p>
      <label>Email<input type="email" autoComplete="username" required value={login.email} onChange={(event) => setLogin({ ...login, email: event.target.value })} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} /></label>
      <button className="primary-button" type="submit" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in"}<span>→</span></button>
      {notice !== "All systems nominal" && <p className="auth-error">{notice}</p>}
    </form></main>;
  }

  return (
    <main className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Northstar control home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>NORTHSTAR<span>/</span></span>
        </a>

        <nav className="navigation" aria-label="Primary navigation">
          <p>CONTROL PLANE</p>
          {navItems.map(([item, symbol]) => (
            <button
              type="button"
              className={activeNav === item ? "nav-item selected" : "nav-item"}
              key={item}
              onClick={() => setActiveNav(item)}
            >
              <span className="nav-symbol">{symbol}</span>
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="control-status">
            <span className="pulse" />
            <div><small>CONTROL STATUS</small><b>Secured · 12ms</b></div>
          </div>
          <button className="profile" type="button" onClick={() => void signOut()}><span>{(user?.displayName || "OW").slice(0, 2).toUpperCase()}</span><div><b>{user?.displayName || "Owner"}</b><small>{user?.email || "Owner"}</small></div><em>↪</em></button>
        </div>
      </aside>

      <section className="content" id="top">
        <header className="topbar">
          <div className="crumb"><span>CONTROL PLANE</span><b>/</b><strong>{activeNav.toUpperCase()}</strong></div>
          <div className="top-actions">
            <span className="system-theme" title="Theme follows your operating system"><i /> System</span>
            <button className="icon-button" type="button" aria-label="Notifications">⌁<span /></button>
            <button className="terminal-shortcut" type="button" disabled={nodes.length === 0} onClick={() => nodes[0] && openTerminal(nodes[0])}>⌘ Logs</button>
            <button className="primary-button" type="button" onClick={openAddNode}><i>+</i> Add node</button>
          </div>
        </header>

        {activeNav === "Overview" && <>
          <section className="hero">
            <div>
              <p className="eyebrow"><span /> LIVE NETWORK</p>
              <h1>Operate the edge.<br /><em>Not the overhead.</em></h1>
              <p className="hero-copy">A single control plane for secure node bootstrap, encrypted recovery access, and agent-first operations.</p>
            </div>
            <div className="hero-trust">
              <span className="ring"><i /></span>
              <div><b>Zero inbound management</b><small>Every managed node calls home over authenticated HTTPS</small></div>
            </div>
          </section>

          <section className="metrics" aria-label="Network metrics">
            <article><span className="metric-label">MANAGED NODES</span><strong>{nodes.length.toString().padStart(2, "0")}</strong><small><i className="up">↗</i> {healthyNodes} healthy now</small></article>
            <article><span className="metric-label">ACTIVE DEVICES</span><strong>{totalUsers}</strong><small><i className="up">↗</i> 14% this week</small></article>
            <article><span className="metric-label">EDGE TRAFFIC</span><strong>4.8 <em>TB</em></strong><small><i className="up">↗</i> last 30 days</small></article>
            <article className="security-metric"><span className="metric-label">RECOVERY VAULT</span><strong>100<em>%</em></strong><small><span className="tiny-lock">⌑</span> credentials sealed</small></article>
          </section>

          <section className="network-grid">
            <article className="coverage-card card">
              <div className="section-title"><div><p>GLOBAL FABRIC</p><h2>Edge coverage</h2></div><button className="plain-action" type="button" onClick={() => setNotice("Topology view is available from the live map.")}>View topology <span>↗</span></button></div>
              <WorldMap nodes={nodes} />
              <div className="coverage-footer"><span><i className="legend online" /> Online <b>{healthyNodes}</b></span><span><i className="legend warning" /> Attention <b>{attentionNodes}</b></span><span><i className="legend queued" /> Deploying <b>{nodes.filter((node) => node.status === "provisioning").length}</b></span></div>
            </article>

            <article className="security-card card">
              <div className="section-title"><div><p>SECURITY POSTURE</p><h2>Recovery, without exposure.</h2></div><button className="kebab" type="button" aria-label="More security options">•••</button></div>
              <div className="security-seal"><div className="seal"><div>⌁</div></div><span>SEALED</span></div>
              <p className="security-copy">Emergency SSH credentials are encrypted per node and never exposed in the browser.</p>
              <div className="security-facts"><div><span>SSH fingerprints</span><b>Verified at bootstrap</b></div><div><span>Latest backup</span><b>Controller managed</b></div></div>
              <button className="secondary-button" type="button" onClick={() => setNotice("Recovery vault opened in read-only audit mode.")}>Open recovery vault <span>→</span></button>
            </article>
          </section>

          <NodeFleet nodes={nodes} regions={regions} onRefresh={() => setNotice("Fleet view refreshed just now.")} onOpenTerminal={openTerminal} onEditNode={openEditNode} onNodeAction={requestNodeAction} busyNodeAction={nodeActionBusy} />
        </>}

        {activeNav === "Nodes" && <section className="module-view">
          <div className="module-heading"><div><p>OPERATIONS</p><h1>Node fleet</h1><span>Provision, monitor, and operate managed VPN nodes.</span></div><strong>{nodes.length} managed</strong></div>
          <NodeFleet nodes={nodes} regions={regions} onRefresh={() => setNotice("Node fleet refreshed just now.")} onOpenTerminal={openTerminal} onEditNode={openEditNode} onNodeAction={requestNodeAction} busyNodeAction={nodeActionBusy} />
        </section>}

        {activeNav === "Regions" && <section className="module-view card">
          <div className="section-title route-title"><div><p>CONTROL PLANE</p><h1>Regions</h1></div><span className="route-status">{regions.length} configured</span></div>
          <div className="regions-workspace">
            <div className="regions-copy">Manage the locations available when provisioning VPN nodes. Changes are reflected on existing nodes assigned to that region.</div>
            <form className="region-form" onSubmit={saveRegion}>
              <label>Name<input required placeholder="e.g. Singapore" value={regionForm.name} onChange={(event) => setRegionForm({ ...regionForm, name: event.target.value })} /></label>
              <label>Country<input required placeholder="e.g. Singapore" value={regionForm.country} onChange={(event) => setRegionForm({ ...regionForm, country: event.target.value })} /></label>
              <label>Code<input required maxLength={8} placeholder="SG" value={regionForm.code} onChange={(event) => setRegionForm({ ...regionForm, code: event.target.value.toUpperCase() })} /></label>
              <div className="region-form-actions"><button className="primary-button" type="submit" disabled={regionBusy}>{regionBusy ? "Saving…" : editingRegionId ? "Save changes" : "Add region"}</button>{editingRegionId && <button className="cancel" type="button" onClick={() => { setEditingRegionId(null); setRegionForm({ name: "", country: "", code: "" }); }}>Cancel</button>}</div>
            </form>
            <div className="region-list">
              {regions.map((region) => <div className="region-row" key={region.id}><span className="flag">{region.code}</span><div><b>{region.name}</b><small>{region.country} · {region.id}</small></div><div className="region-actions"><button type="button" onClick={() => editRegion(region)}>Edit</button><button type="button" onClick={() => void removeRegion(region)}>Delete</button></div></div>)}
            </div>
          </div>
        </section>}

        {activeNav === "Access" && <section className="module-view card access-workspace">
          <div className="section-title route-title"><div><p>USER ACCESS</p><h1>Connect a device</h1></div><span className="route-status">WireGuard · Auto-ready</span></div>
          <div className="access-copy">Choose a healthy node and create a local WireGuard profile. The private key is generated in this browser and is never sent to the Controller.</div>
          <div className="access-form">
            <label>Edge node<select value={accessNodeId || nodes.find((node) => node.status === "online")?.id || ""} onChange={(event) => setAccessNodeId(event.target.value)}>{nodes.length === 0 && <option value="">No nodes available</option>}{nodes.map((node) => <option key={node.id} value={node.id} disabled={node.status !== "online"}>{node.name} · {node.place} · {node.status}</option>)}</select></label>
            <label>Device name<input value={accessDeviceName} maxLength={120} onChange={(event) => setAccessDeviceName(event.target.value)} placeholder="My Mac" /></label>
            <button className="primary-button" type="button" disabled={accessBusy || nodes.every((node) => node.status !== "online")} onClick={() => void createMacAccessProfile()}>{accessBusy ? "Preparing profile…" : "Prepare Mac profile"}<span>→</span></button>
          </div>
          {accessError && <p className="form-error" role="alert">{accessError}</p>}
          {accessConfig && <div className="access-result"><div><p className="eyebrow"><span /> PROFILE READY</p><h2>Import this profile into WireGuard.</h2><p>Download the file, open WireGuard on macOS, choose <b>Import tunnel(s) from file</b>, then activate the tunnel. Keep the downloaded file private.</p></div><button className="secondary-button access-download" type="button" onClick={downloadAccessConfig}>Download {accessConfig.name} <span>↓</span></button><details><summary>Show configuration</summary><pre>{accessConfig.config}</pre></details></div>}
          <div className="access-devices"><div className="diagnostics-section-head"><b>Registered devices</b><span>{accessDevices.length}</span></div>{accessDevices.length ? accessDevices.map((device) => <div className="access-device" key={device.id}><span className="flag">MAC</span><div><b>{device.displayName}</b><small>{device.status} · {device.publicKey.slice(0, 16)}…</small></div>{device.status === "active" && <button className="access-device-revoke" type="button" disabled={accessDeviceBusy === device.id} onClick={() => setPendingDeviceRevocation(device)}>{accessDeviceBusy === device.id ? "Revoking…" : "Revoke"}</button>}</div>) : <p className="diagnostics-empty">No devices have been registered yet.</p>}</div>
        </section>}

        {(activeNav === "Sessions" || activeNav === "Audit") && <section className="module-view card module-placeholder">
          <p>CONTROL PLANE</p><h1>{activeNav}</h1>
          <b>{activeNav} is not enabled in this release.</b>
          <span>Only Overview, Nodes, Regions, and secure node bootstrap are currently available for production operations.</span>
        </section>}

        <footer className="notice"><span>✦</span>{notice}<button type="button" onClick={() => setNotice("All systems nominal")}>Dismiss</button></footer>
      </section>

      {showDeploy && (
        <div className="modal-layer" role="presentation" onMouseDown={() => !deploying && setShowDeploy(false)}>
          <section className="modal deploy-modal" role="dialog" aria-modal="true" aria-labelledby="deploy-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><p>{editingNodeId ? "NODE CONFIGURATION" : "SECURE BOOTSTRAP"}</p><h2 id="deploy-title">{editingNodeId ? "Edit managed node" : "Add a managed node"}</h2></div><button type="button" onClick={() => setShowDeploy(false)} aria-label="Close node form">×</button></div>
            {!editingNodeId && <div className="stepper"><span className="complete">01 <b>Connection</b></span><i /><span>02 <b>Verify</b></span><i /><span>03 <b>Deploy</b></span></div>}
            <form onSubmit={deployNode}>
              <label>Node name<input autoFocus placeholder="e.g. Singapore Edge" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <div className="field-pair"><label>Public IP<input placeholder="203.0.113.10" value={form.ip} onChange={(event) => setForm({ ...form, ip: event.target.value })} /></label><label>Region<select required value={form.regionId} onChange={(event) => setForm({ ...form, regionId: event.target.value })}>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}</option>)}</select></label></div>
              <div className="field-pair"><label>SSH user<input autoComplete="username" value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} /></label><label>SSH password or private key<input type="password" autoComplete="current-password" placeholder={editingNodeId ? "Leave blank to keep existing credential" : "Encrypted on the controller"} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></label></div>
              <div className="fingerprint-field">
                <div className="fingerprint-label"><label htmlFor="host-fingerprint">SSH host fingerprint</label><button type="button" className="help-toggle" onClick={() => setShowFingerprintGuide((current) => !current)} aria-expanded={showFingerprintGuide}>{showFingerprintGuide ? "收起" : "如何获取？"}</button></div>
                <input id="host-fingerprint" placeholder="SHA256:… (required in production)" value={form.hostFingerprint} onChange={(event) => setForm({ ...form, hostFingerprint: event.target.value })} />
                {showFingerprintGuide && <aside className="fingerprint-guide"><b>在目标 VPN 节点上获取</b><p>请先通过云厂商控制台或已确认安全的 SSH 会话登录目标服务器，然后执行：</p><div className="fingerprint-command"><code>{fingerprintCommand}</code><button type="button" onClick={() => void copyFingerprintCommand()}>{fingerprintCommandCopied ? "已复制" : "复制命令"}</button></div><p>可以粘贴整行输出，系统会自动提取 <strong>SHA256:</strong> 指纹。如果没有 ed25519 主机密钥，可改用 <code>/etc/ssh/ssh_host_rsa_key.pub</code>。</p><small>不要直接把本次首次连接得到的指纹自动当作可信值；请通过云控制台或其他可信渠道核对。</small></aside>}
              </div>
              <p className="form-note"><span>⌑</span> The controller verifies the host key and encrypts this credential with the server master key. It is never returned to the browser.</p>
              {deployError && <p className="form-error" role="alert">{deployError}</p>}
              <div className="modal-actions"><button type="button" className="cancel" onClick={() => setShowDeploy(false)}>Cancel</button><button className="primary-button" type="submit" disabled={deploying}>{deploying ? (editingNodeId ? "Saving…" : "Creating signed task…") : (editingNodeId ? "Save changes" : "Verify & deploy")}<span>→</span></button></div>
            </form>
          </section>
        </div>
      )}

      {showTerminal && (
        <div className="modal-layer" role="presentation" onMouseDown={() => setShowTerminal(false)}>
          <section className="modal terminal-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><p>NODE DIAGNOSTICS</p><h2 id="terminal-title">{selectedNode.name}</h2></div><button type="button" onClick={() => setShowTerminal(false)} aria-label="Close diagnostics">×</button></div>
            <div className="terminal-meta"><span><i className="pulse" /> Deployment log</span><span>Bootstrap + Agent reconcile</span><span>Auto-refresh 5s</span></div>
            <div className="terminal-window">
              <div className="terminal-bar"><span><i /><i /><i /></span><small>northstar/{selectedNode.id}</small><b>{diagnosticsBusy ? "Refreshing…" : `${nodeDiagnostics?.actions.length || 0} recorded events`}</b></div>
              {diagnosticsBusy && !nodeDiagnostics ? <div className="terminal-ready"><div className="terminal-orbit">⌁</div><b>Loading deployment diagnostics…</b><p>Reading the controller’s audited bootstrap and Agent reconcile records.</p></div> : nodeDiagnostics && <div className="diagnostics-body">
                <div className="diagnostics-grid"><div><span>NODE STATUS</span><b className={`diagnostic-${selectedNode.status}`}>{selectedNode.status}</b></div><div><span>LAST SEEN</span><b>{selectedNode.lastSeen}</b></div><div><span>AGENT VERSION</span><b>{selectedNode.version}</b></div></div>
                <div className="diagnostics-section"><div className="diagnostics-section-head"><b>Resource health</b></div><ResourceMetrics metrics={selectedNode.metrics} /></div>
                <div className="diagnostics-section"><div className="diagnostics-section-head"><b>Recent deployment events</b><button type="button" onClick={() => void loadNodeDiagnostics(selectedNode.id)}>Refresh</button></div>
                  {nodeDiagnostics.actions.length ? nodeDiagnostics.actions.map((action) => <article className="diagnostic-event" key={action.id}><div><b>{action.action}</b><span>{action.status} · {action.finished_at || action.created_at}</span></div>{action.error && <pre className="diagnostic-error">{action.error}</pre>}{action.output && <pre>{action.output}</pre>}</article>) : <p className="diagnostics-empty">No deployment events recorded yet.</p>}
                </div>
                <div className="diagnostics-section"><div className="diagnostics-section-head"><b>WireGuard reconcile</b></div>
                  {nodeDiagnostics.reconcile.tasks.length ? nodeDiagnostics.reconcile.tasks.slice(0, 5).map((task) => <article className="diagnostic-task" key={task.id}><span>{task.protocol} · {task.taskType}</span><b className={`diagnostic-${task.status}`}>{task.status}</b>{task.lastError && <pre className="diagnostic-error">{task.lastError}</pre>}</article>) : <p className="diagnostics-empty">No protocol tasks have been queued.</p>}
                </div>
              </div>}
            </div>
            <div className="terminal-footer"><span>Output is recorded to the encrypted audit log.</span><div><button type="button" onClick={() => requestNodeAction(selectedNode, "bootstrap")}>Retry bootstrap</button><button type="button" onClick={() => requestNodeAction(selectedNode, "status-agent")}>Check agent</button><button type="button" onClick={() => requestNodeAction(selectedNode, "restart-agent")}>Restart agent</button><button type="button" className="danger-button" disabled={Boolean(nodeActionBusy)} onClick={() => requestNodeAction(selectedNode, "delete")}>{nodeActionBusy === `${selectedNode.id}:delete` ? "Deleting…" : "Delete node"}</button></div></div>
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingNodeConfirmation)}
        title={pendingNodeConfirmation?.title || "Confirm action"}
        description={pendingNodeConfirmation?.description || "Confirm this node operation."}
        confirmLabel={pendingNodeConfirmation?.confirmLabel || "Confirm"}
        tone={pendingNodeConfirmation?.tone || "warning"}
        busy={Boolean(nodeActionBusy)}
        onCancel={() => setPendingNodeConfirmation(null)}
        onConfirm={() => void confirmNodeAction()}
      />
      <ConfirmDialog
        open={Boolean(pendingDeviceRevocation)}
        eyebrow="REVOKE DEVICE"
        title={`Revoke ${pendingDeviceRevocation?.displayName || "this device"}?`}
        description="This immediately revokes its profile and removes the device public key from the next WireGuard reconciliation. The downloaded configuration will stop working after the node applies the update."
        confirmLabel="Revoke device"
        tone="danger"
        busy={Boolean(accessDeviceBusy)}
        onCancel={() => setPendingDeviceRevocation(null)}
        onConfirm={() => pendingDeviceRevocation && void revokeAccessDevice(pendingDeviceRevocation)}
      />
    </main>
  );
}
