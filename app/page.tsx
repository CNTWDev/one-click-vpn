"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import worldMap from "@svg-maps/world";

type NodeStatus = "online" | "provisioning" | "attention";

type Node = {
  id: string;
  name: string;
  place: string;
  ip: string;
  status: NodeStatus;
  latency: string;
  users: number;
  traffic: string;
  version: string;
  lastSeen: string;
};

type Region = {
  id: string;
  name: string;
  country: string;
  code: string;
};

const initialNodes: Node[] = [
  {
    id: "fra-01",
    name: "Frankfurt Edge",
    place: "Frankfurt · Germany",
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
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node>(initialNodes[0]);
  const [notice, setNotice] = useState("All systems nominal");
  const [form, setForm] = useState({ name: "", ip: "", user: "root", secret: "", regionId: "tokyo-jp", hostFingerprint: "" });
  const [regionForm, setRegionForm] = useState({ name: "", country: "", code: "" });
  const [editingRegionId, setEditingRegionId] = useState<string | null>(null);
  const [regionBusy, setRegionBusy] = useState(false);
  const [showFingerprintGuide, setShowFingerprintGuide] = useState(false);
  const [fingerprintCommandCopied, setFingerprintCommandCopied] = useState(false);

  async function loadNodes() {
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
      latency: String(node.latency),
      users: Number(node.users || 0),
      traffic: String(node.traffic || "—"),
      version: String(node.version || "unknown"),
      lastSeen: String(node.last_seen || "never"),
    })));
  }

  async function loadRegions() {
    const response = await fetch("/api/regions", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { regions: Region[] };
    setRegions(payload.regions);
    setForm((current) => ({ ...current, regionId: payload.regions.some((region) => region.id === current.regionId) ? current.regionId : payload.regions[0]?.id || "" }));
  }

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
  }, []);

  const totalUsers = useMemo(() => nodes.reduce((sum, node) => sum + node.users, 0), [nodes]);
  const healthyNodes = nodes.filter((node) => node.status === "online").length;

  function openTerminal(node: Node) {
    setSelectedNode(node);
    setTerminalStarted(false);
    setShowTerminal(true);
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

  async function deployNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name || !form.ip || !form.secret) {
      setNotice("Complete the node name, public IP, and temporary SSH credential.");
      return;
    }

    setDeploying(true);
    setNotice("Verifying SSH host key and preparing a signed deployment task…");
    const response = await fetch("/api/nodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: form.name, ip: form.ip, regionId: form.regionId, sshUser: form.user, secret: form.secret, hostFingerprint: form.hostFingerprint,
    }) });
    const payload = await response.json().catch(() => ({})) as { error?: string; node?: Node };
    setDeploying(false);
    if (!response.ok || !payload.node) {
      setNotice(payload.error || "Unable to create node");
      return;
    }
    setNodes((current) => [payload.node!, ...current]);
    setShowDeploy(false);
    setForm({ name: "", ip: "", user: "root", secret: "", regionId: regions[0]?.id || "", hostFingerprint: "" });
    setNotice(`${payload.node.name} is queued for secure bootstrap. The credential is encrypted server-side.`);
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

  async function requestAction(label: string, action?: "restart-agent" | "status-agent") {
    if (action) {
      const response = await fetch(`/api/nodes/${selectedNode.id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setNotice(response.ok ? `${label} completed for ${selectedNode.name}.` : (payload.error || `${label} failed.`));
    } else {
      setNotice(`${label} is available only through the encrypted, audited SSH path.`);
    }
    setShowTerminal(false);
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
          <button className="profile" onClick={() => void signOut()}><span>{(user?.displayName || "OW").slice(0, 2).toUpperCase()}</span><div><b>{user?.displayName || "Owner"}</b><small>{user?.email || "Owner"}</small></div><em>↪</em></button>
        </div>
      </aside>

      <section className="content" id="top">
        <header className="topbar">
          <div className="crumb"><span>CONTROL PLANE</span><b>/</b><strong>{activeNav.toUpperCase()}</strong></div>
          <div className="top-actions">
            <span className="system-theme" title="Theme follows your operating system"><i /> System</span>
            <button className="icon-button" aria-label="Notifications">⌁<span /></button>
            <button className="terminal-shortcut" onClick={() => openTerminal(nodes[0])}>⌘ Terminal</button>
            <button className="primary-button" onClick={() => setShowDeploy(true)}><i>+</i> Add node</button>
          </div>
        </header>

        {activeNav !== "Overview" && (
          <section className="route-panel card">
            <div className="section-title route-title"><div><p>CONTROL PLANE</p><h2>{activeNav}</h2></div><span className="route-status">{activeNav === "Regions" ? `${regions.length} configured` : "Module ready"}</span></div>
            {activeNav === "Regions" ? (
              <div className="regions-workspace">
                <div className="regions-copy">Manage the locations available when provisioning VPN nodes. Changes are reflected on existing nodes assigned to that region.</div>
                <form className="region-form" onSubmit={saveRegion}>
                  <label>Name<input required placeholder="e.g. Singapore" value={regionForm.name} onChange={(event) => setRegionForm({ ...regionForm, name: event.target.value })} /></label>
                  <label>Country<input required placeholder="e.g. Singapore" value={regionForm.country} onChange={(event) => setRegionForm({ ...regionForm, country: event.target.value })} /></label>
                  <label>Code<input required maxLength={8} placeholder="SG" value={regionForm.code} onChange={(event) => setRegionForm({ ...regionForm, code: event.target.value.toUpperCase() })} /></label>
                  <div className="region-form-actions"><button className="primary-button" type="submit" disabled={regionBusy}>{regionBusy ? "Saving…" : editingRegionId ? "Save changes" : "Add region"}</button>{editingRegionId && <button className="cancel" type="button" onClick={() => { setEditingRegionId(null); setRegionForm({ name: "", country: "", code: "" }); }}>Cancel</button>}</div>
                </form>
                <div className="region-list">
                  {regions.map((region) => <div className="region-row" key={region.id}><span className="flag">{region.code}</span><div><b>{region.name}</b><small>{region.country} · {region.id}</small></div><div className="region-actions"><button onClick={() => editRegion(region)}>Edit</button><button onClick={() => void removeRegion(region)}>Delete</button></div></div>)}
                </div>
              </div>
            ) : (
              <div className="module-placeholder"><b>{activeNav} is connected to the control plane.</b><span>This workspace is ready for the next operational module. Use Overview, Nodes, and Regions for the currently available controls.</span></div>
            )}
          </section>
        )}

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
            <div className="section-title"><div><p>GLOBAL FABRIC</p><h2>Edge coverage</h2></div><button className="plain-action">View topology <span>↗</span></button></div>
            <WorldMap nodes={nodes} />
            <div className="coverage-footer"><span><i className="legend online" /> Online <b>2</b></span><span><i className="legend warning" /> Attention <b>1</b></span><span><i className="legend queued" /> Deploying <b>{nodes.filter((node) => node.status === "provisioning").length}</b></span></div>
          </article>

          <article className="security-card card">
            <div className="section-title"><div><p>SECURITY POSTURE</p><h2>Recovery, without exposure.</h2></div><button className="kebab" aria-label="More security options">•••</button></div>
            <div className="security-seal"><div className="seal"><div>⌁</div></div><span>SEALED</span></div>
            <p className="security-copy">Emergency SSH credentials are encrypted per node and never exposed in the browser.</p>
            <div className="security-facts"><div><span>SSH fingerprints</span><b>3 verified</b></div><div><span>Latest backup</span><b>18 min ago</b></div></div>
            <button className="secondary-button" onClick={() => setNotice("Recovery vault opened in read-only audit mode.")}>Open recovery vault <span>→</span></button>
          </article>
        </section>

        <section className="nodes-section">
          <div className="section-title nodes-title"><div><p>EDGE NODES</p><h2>Fleet status</h2></div><div className="node-toolbar"><button className="filter-button">All regions <span>⌄</span></button><button className="plain-action" onClick={() => setNotice("Fleet view refreshed just now.")}>Refresh <span>↻</span></button></div></div>
          <div className="node-list">
            <div className="node-head"><span>NODE</span><span>STATUS</span><span>LATENCY</span><span>DEVICES</span><span>TRAFFIC</span><span /></div>
            {nodes.map((node) => (
              <article className="node-row" key={node.id}>
                <div className="node-name"><span className="flag">{node.place.includes("Germany") ? "DE" : node.place.includes("Japan") ? "JP" : node.place.includes("USA") ? "US" : "●"}</span><div><b>{node.name}</b><small>{node.place} · {node.ip}</small></div></div>
                <StatusPill status={node.status} />
                <div className={node.status === "attention" ? "node-value danger" : "node-value"}>{node.latency}<small>last seen {node.lastSeen}</small></div>
                <div className="node-value">{node.users}<small>authorized</small></div>
                <div className="node-value">{node.traffic}<small>{node.version}</small></div>
                <div className="row-actions"><button onClick={() => openTerminal(node)}>Terminal</button><button aria-label={`Node actions for ${node.name}`} onClick={() => { setSelectedNode(node); setNotice(`${node.name} selected for an administrative action.`); }}>•••</button></div>
              </article>
            ))}
          </div>
        </section>

        <footer className="notice"><span>✦</span>{notice}<button onClick={() => setNotice("All systems nominal")}>Dismiss</button></footer>
      </section>

      {showDeploy && (
        <div className="modal-layer" role="presentation" onMouseDown={() => !deploying && setShowDeploy(false)}>
          <section className="modal deploy-modal" role="dialog" aria-modal="true" aria-labelledby="deploy-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><p>SECURE BOOTSTRAP</p><h2 id="deploy-title">Add a managed node</h2></div><button onClick={() => setShowDeploy(false)} aria-label="Close add node">×</button></div>
            <div className="stepper"><span className="complete">01 <b>Connection</b></span><i /><span>02 <b>Verify</b></span><i /><span>03 <b>Deploy</b></span></div>
            <form onSubmit={deployNode}>
              <label>Node name<input autoFocus placeholder="e.g. Singapore Edge" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <div className="field-pair"><label>Public IP<input placeholder="203.0.113.10" value={form.ip} onChange={(event) => setForm({ ...form, ip: event.target.value })} /></label><label>Region<select required value={form.regionId} onChange={(event) => setForm({ ...form, regionId: event.target.value })}>{regions.map((region) => <option key={region.id} value={region.id}>{region.name} · {region.country}</option>)}</select></label></div>
              <div className="field-pair"><label>SSH user<input value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} /></label><label>SSH password or private key<input type="password" placeholder="Encrypted on the controller" value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></label></div>
              <div className="fingerprint-field">
                <div className="fingerprint-label"><label htmlFor="host-fingerprint">SSH host fingerprint</label><button type="button" className="help-toggle" onClick={() => setShowFingerprintGuide((current) => !current)} aria-expanded={showFingerprintGuide}>{showFingerprintGuide ? "收起" : "如何获取？"}</button></div>
                <input id="host-fingerprint" placeholder="SHA256:… (required in production)" value={form.hostFingerprint} onChange={(event) => setForm({ ...form, hostFingerprint: event.target.value })} />
                {showFingerprintGuide && <aside className="fingerprint-guide"><b>在目标 VPN 节点上获取</b><p>请先通过云厂商控制台或已确认安全的 SSH 会话登录目标服务器，然后执行：</p><div className="fingerprint-command"><code>{fingerprintCommand}</code><button type="button" onClick={() => void copyFingerprintCommand()}>{fingerprintCommandCopied ? "已复制" : "复制命令"}</button></div><p>复制输出中以 <strong>SHA256:</strong> 开头的值，粘贴到上面的输入框。如果没有 ed25519 主机密钥，可改用 <code>/etc/ssh/ssh_host_rsa_key.pub</code>。</p><small>不要直接把本次首次连接得到的指纹自动当作可信值；请通过云控制台或其他可信渠道核对。</small></aside>}
              </div>
              <p className="form-note"><span>⌑</span> The controller verifies the host key and encrypts this credential with the server master key. It is never returned to the browser.</p>
              <div className="modal-actions"><button type="button" className="cancel" onClick={() => setShowDeploy(false)}>Cancel</button><button className="primary-button" type="submit" disabled={deploying}>{deploying ? "Creating signed task…" : "Verify & deploy"}<span>→</span></button></div>
            </form>
          </section>
        </div>
      )}

      {showTerminal && (
        <div className="modal-layer" role="presentation" onMouseDown={() => setShowTerminal(false)}>
          <section className="modal terminal-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><p>TIME-BOUND SESSION</p><h2 id="terminal-title">{selectedNode.name}</h2></div><button onClick={() => setShowTerminal(false)} aria-label="Close terminal">×</button></div>
            <div className="terminal-meta"><span><i className="pulse" /> Agent tunnel</span><span>TLS + token verified</span><span>15 min maximum</span></div>
            <div className="terminal-window">
              <div className="terminal-bar"><span><i /><i /><i /></span><small>vpnops@{selectedNode.id}: ~</small><b>SSH certificate · expires 14:59</b></div>
              {terminalStarted ? <pre><span>vpnops@{selectedNode.id}:~$</span> sudo systemctl status vpn-agent
<b>● vpn-agent.service - Northstar node agent</b>
   Active: <em>active (running)</em> since today
   Secure transport: outbound HTTPS / connected
<span>vpnops@{selectedNode.id}:~$</span> <i className="cursor" /></pre> : <div className="terminal-ready"><div className="terminal-orbit">⌁</div><b>Ready to open a signed SSH session</b><p>Your password is not used. This route travels through the node’s existing outbound Agent channel.</p><button className="primary-button" onClick={() => setTerminalStarted(true)}>Start secure session <span>→</span></button></div>}
            </div>
            <div className="terminal-footer"><span>Actions are recorded to the encrypted audit log.</span><div><button onClick={() => void requestAction("Restart agent", "restart-agent")}>Restart agent</button><button className="danger-button" onClick={() => void requestAction("Emergency SSH fallback")}>Use emergency SSH</button></div></div>
          </section>
        </div>
      )}
    </main>
  );
}
