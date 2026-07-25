"use client";

import { type FormEvent, useMemo, useState } from "react";

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
  ["Access", "⌁"],
  ["Sessions", "▣"],
  ["Audit", "◌"],
];

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

function WorldMap() {
  return (
    <div className="world-map" aria-label="Global node coverage map">
      <div className="map-grid" />
      <div className="map-arc map-arc-one" />
      <div className="map-arc map-arc-two" />
      <div className="continent continent-one" />
      <div className="continent continent-two" />
      <div className="continent continent-three" />
      <div className="continent continent-four" />
      <span className="map-node map-node-fra"><b />Frankfurt</span>
      <span className="map-node map-node-tyo"><b />Tokyo</span>
      <span className="map-node map-node-lax"><b />Los Angeles</span>
      <span className="map-node map-node-ctl"><b />Control</span>
      <div className="map-caption">3 edge nodes · one control plane</div>
    </div>
  );
}

export default function Home() {
  const [nodes, setNodes] = useState(initialNodes);
  const [activeNav, setActiveNav] = useState("Overview");
  const [showDeploy, setShowDeploy] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [selectedNode, setSelectedNode] = useState<Node>(initialNodes[0]);
  const [notice, setNotice] = useState("All systems nominal");
  const [form, setForm] = useState({ name: "", ip: "", user: "root", secret: "", region: "Tokyo · Japan" });

  const totalUsers = useMemo(() => nodes.reduce((sum, node) => sum + node.users, 0), [nodes]);
  const healthyNodes = nodes.filter((node) => node.status === "online").length;

  function openTerminal(node: Node) {
    setSelectedNode(node);
    setTerminalStarted(false);
    setShowTerminal(true);
  }

  function deployNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.name || !form.ip || !form.secret) {
      setNotice("Complete the node name, public IP, and temporary SSH credential.");
      return;
    }

    setDeploying(true);
    setNotice("Verifying SSH host key and preparing a signed deployment task…");
    window.setTimeout(() => {
      const newNode: Node = {
        id: `node-${nodes.length + 1}`,
        name: form.name,
        place: form.region,
        ip: form.ip,
        status: "provisioning",
        latency: "checking",
        users: 0,
        traffic: "—",
        version: "bootstrap pending",
        lastSeen: "just added",
      };
      setNodes((current) => [newNode, ...current]);
      setDeploying(false);
      setShowDeploy(false);
      setForm({ name: "", ip: "", user: "root", secret: "", region: "Tokyo · Japan" });
      setNotice(`${newNode.name} is queued for secure bootstrap. The temporary SSH credential is sealed for recovery use.`);
    }, 900);
  }

  function requestAction(label: string) {
    setNotice(`${label} request created for ${selectedNode.name}. The node agent will acknowledge it through its outbound secure channel.`);
    setShowTerminal(false);
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
          <button className="profile"><span>TW</span><div><b>Tuan Wei</b><small>Owner</small></div><em>⌄</em></button>
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

        <section className="hero">
          <div>
            <p className="eyebrow"><span /> LIVE NETWORK</p>
            <h1>Operate the edge.<br /><em>Not the overhead.</em></h1>
            <p className="hero-copy">A single control plane for secure node bootstrap, encrypted recovery access, and agent-first operations.</p>
          </div>
          <div className="hero-trust">
            <span className="ring"><i /></span>
            <div><b>Zero inbound management</b><small>Every managed node calls home over mTLS</small></div>
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
            <WorldMap />
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
              <div className="field-pair"><label>Public IP<input placeholder="203.0.113.10" value={form.ip} onChange={(event) => setForm({ ...form, ip: event.target.value })} /></label><label>Region<select value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })}><option>Tokyo · Japan</option><option>Singapore · Singapore</option><option>Frankfurt · Germany</option><option>Los Angeles · USA</option></select></label></div>
              <div className="field-pair"><label>SSH user<input value={form.user} onChange={(event) => setForm({ ...form, user: event.target.value })} /></label><label>Temporary SSH password<input type="password" placeholder="Stored encrypted for recovery" value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></label></div>
              <p className="form-note"><span>⌑</span> The controller validates the host key before deployment. This credential is encrypted server-side and is never returned to the browser.</p>
              <div className="modal-actions"><button type="button" className="cancel" onClick={() => setShowDeploy(false)}>Cancel</button><button className="primary-button" type="submit" disabled={deploying}>{deploying ? "Creating signed task…" : "Verify & deploy"}<span>→</span></button></div>
            </form>
          </section>
        </div>
      )}

      {showTerminal && (
        <div className="modal-layer" role="presentation" onMouseDown={() => setShowTerminal(false)}>
          <section className="modal terminal-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><p>TIME-BOUND SESSION</p><h2 id="terminal-title">{selectedNode.name}</h2></div><button onClick={() => setShowTerminal(false)} aria-label="Close terminal">×</button></div>
            <div className="terminal-meta"><span><i className="pulse" /> Agent tunnel</span><span>mTLS verified</span><span>15 min maximum</span></div>
            <div className="terminal-window">
              <div className="terminal-bar"><span><i /><i /><i /></span><small>vpnops@{selectedNode.id}: ~</small><b>SSH certificate · expires 14:59</b></div>
              {terminalStarted ? <pre><span>vpnops@{selectedNode.id}:~$</span> sudo systemctl status vpn-agent
<b>● vpn-agent.service - Northstar node agent</b>
   Active: <em>active (running)</em> since today
   Secure transport: mTLS outbound / connected
<span>vpnops@{selectedNode.id}:~$</span> <i className="cursor" /></pre> : <div className="terminal-ready"><div className="terminal-orbit">⌁</div><b>Ready to open a signed SSH session</b><p>Your password is not used. This route travels through the node’s existing outbound Agent channel.</p><button className="primary-button" onClick={() => setTerminalStarted(true)}>Start secure session <span>→</span></button></div>}
            </div>
            <div className="terminal-footer"><span>Session will be recorded to the encrypted audit log.</span><div><button onClick={() => requestAction("Restart agent")}>Restart agent</button><button className="danger-button" onClick={() => requestAction("Emergency SSH fallback")}>Use emergency SSH</button></div></div>
          </section>
        </div>
      )}
    </main>
  );
}
