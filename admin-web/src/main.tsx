/* eslint-disable react-hooks/set-state-in-effect */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import {
  ControllerPage, LogsPage, NodesPage, OverviewPage, RegionsPage, ServicesPage, TopologyPage, UsersPage,
} from "./pages";
import type { AdminUser, ControllerInfo, NodeRecord, Region } from "./types";
import "./styles.css";
import "./credential-usage.css";

type PageId = "overview" | "topology" | "users" | "nodes" | "services" | "regions" | "controller" | "logs";
const navigation: Array<{ id: PageId; icon: string; label: string; description: string }> = [
  { id: "overview", icon: "⌂", label: "运维总览", description: "状态与待处理" },
  { id: "topology", icon: "G", label: "全球拓扑", description: "节点分布与管理通道" },
  { id: "users", icon: "U", label: "账号管理", description: "审核与访问控制" },
  { id: "nodes", icon: "N", label: "节点运维", description: "部署、修复与诊断" },
  { id: "services", icon: "V", label: "VPN 服务", description: "协议与部署策略" },
  { id: "regions", icon: "R", label: "区域管理", description: "节点区域目录" },
  { id: "controller", icon: "C", label: "Controller", description: "控制面设置" },
  { id: "logs", icon: "L", label: "运行日志", description: "故障定位" },
];

function Brand() {
  return <div className="brand"><span className="mark"><i /><i /><i /></span><span>NORTHSTAR <em>CONSOLE</em></span></div>;
}

function Login({ onUser }: { onUser: (user: AdminUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ user: AdminUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (!result.user?.id) throw new Error("登录接口返回异常，请检查 Console 的 /api/ 反向代理。");
      onUser(result.user);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="login">
    <Brand />
    <form onSubmit={submit}>
      <p className="eyebrow">CONTROL PLANE</p><h1>管理控制台</h1><p>账号审核、节点部署与修复、VPN 服务和运行诊断。</p>
      <label>管理员邮箱<input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>密码<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "登录中…" : "登录 Console"} →</button>
      {error && <div className="login-error" role="alert">{error}</div>}
    </form>
  </main>;
}

function App() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [controllerSettings, setControllerSettings] = useState<ControllerInfo["settings"] | null>(null);
  const [page, setPage] = useState<PageId>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");

  const refreshCore = useCallback(async () => {
    setDataLoading(true); setError("");
    try {
      const [userResult, nodeResult, regionResult, controllerResult] = await Promise.all([
        api<{ users: AdminUser[] }>("/api/v1/admin/users"),
        api<{ nodes: NodeRecord[] }>("/api/nodes"),
        api<{ regions: Region[] }>("/api/regions"),
        api<ControllerInfo>("/api/controller"),
      ]);
      setUsers(userResult.users || []); setNodes(nodeResult.nodes || []); setRegions(regionResult.regions || []); setControllerSettings(controllerResult.settings);
    } catch (reason) { setError((reason as Error).message); }
    finally { setDataLoading(false); }
  }, []);

  useEffect(() => {
    api<{ user: AdminUser }>("/api/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (user) void refreshCore(); }, [user, refreshCore]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setUser(null); setUsers([]); setNodes([]); setRegions([]); setControllerSettings(null); setPage("overview");
  }
  function navigate(next: string) { setPage(next as PageId); setMenuOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }

  if (loading) return <main className="loading"><Brand /><span>正在连接控制面…</span></main>;
  if (!user) return <Login onUser={setUser} />;

  const current = navigation.find((item) => item.id === page)!;
  return <main className="app-shell">
    <aside className={menuOpen ? "open" : ""}>
      <div className="aside-head"><Brand /><button className="icon-button mobile-only" onClick={() => setMenuOpen(false)}>×</button></div>
      <nav aria-label="管理控制台导航">{navigation.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item.id)}><span className="nav-icon">{item.icon}</span><span><b>{item.label}</b><small>{item.description}</small></span>{item.id === "users" && users.some((account) => account.status === "pending") && <em>{users.filter((account) => account.status === "pending").length}</em>}</button>)}</nav>
      <div className="aside-health"><span className="live-mark" /><span><b>Controller API</b><small>{error ? "连接异常" : dataLoading ? "同步数据中" : "已认证 · 运行中"}</small></span></div>
      <div className="aside-user"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><b>{user.displayName}</b><small>{user.email}</small></span><button className="text-button" onClick={() => void logout()}>退出</button></div>
    </aside>
    {menuOpen && <button className="menu-scrim" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}
    <section className="workspace">
      <header className="topbar"><button className="icon-button mobile-only" onClick={() => setMenuOpen(true)}>☰</button><div><small>Northstar Console</small><b>{current.label}</b></div><span>{dataLoading ? "正在同步…" : `${nodes.filter((node) => node.status === "online").length}/${nodes.length} 节点在线`}</span></header>
      <div className="content">
        {error && <div className="inline-notice error" role="alert">{error}<button className="text-button" onClick={() => void refreshCore()}>重试</button></div>}
        {page === "overview" && <OverviewPage users={users} nodes={nodes} regions={regions} controllerSettings={controllerSettings} onNavigate={navigate} onRefresh={refreshCore} />}
        {page === "topology" && <TopologyPage nodes={nodes} regions={regions} controllerSettings={controllerSettings} onNavigate={navigate} onRefresh={refreshCore} />}
        {page === "users" && <UsersPage users={users} onRefresh={refreshCore} />}
        {page === "nodes" && <NodesPage nodes={nodes} regions={regions} onRefresh={refreshCore} />}
        {page === "services" && <ServicesPage nodes={nodes} />}
        {page === "regions" && <RegionsPage regions={regions} nodes={nodes} onRefresh={refreshCore} />}
        {page === "controller" && <ControllerPage onSettingsChange={setControllerSettings} />}
        {page === "logs" && <LogsPage nodes={nodes} />}
      </div>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
