import { BrandMark } from "../../shared/brand";
import { ConsoleLanguage, ConsoleLanguagePicker, t, useConsoleLanguage } from "./i18n";
/* eslint-disable react-hooks/set-state-in-effect */
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, isUnauthorized, setUnauthorizedHandler } from "./api";
import { ConfirmProvider } from "./confirm-dialog";
import { Icon, type IconName } from "./icons";
import { href, useRoute } from "./router";
import { applyTheme, type ThemeChoice, useTheme } from "./theme";
import { ToastProvider } from "./toast";
import type { AdminUser, ControllerInfo, NodeRecord, Region } from "./types";
import "./styles.css";
import "./credential-usage.css";
import { SubscriptionPanel } from "../../shared/subscription-panel";

// Each console page is its own chunk, fetched the first time it is opened.
const OverviewPage = lazy(() => import("./pages/overview").then((module) => ({ default: module.OverviewPage })));
const TopologyPage = lazy(() => import("./pages/topology").then((module) => ({ default: module.TopologyPage })));
const UsersPage = lazy(() => import("./pages/users").then((module) => ({ default: module.UsersPage })));
const NodesPage = lazy(() => import("./pages/nodes").then((module) => ({ default: module.NodesPage })));
const ServicesPage = lazy(() => import("./pages/services").then((module) => ({ default: module.ServicesPage })));
const RegionsPage = lazy(() => import("./pages/regions").then((module) => ({ default: module.RegionsPage })));
const ControllerPage = lazy(() => import("./pages/controller").then((module) => ({ default: module.ControllerPage })));
const ReleasesPage = lazy(() => import("./pages/releases").then((module) => ({ default: module.ReleasesPage })));
const LogsPage = lazy(() => import("./pages/logs").then((module) => ({ default: module.LogsPage })));

type PageId = "overview" | "topology" | "users" | "subscriptions" | "nodes" | "services" | "regions" | "controller" | "logs" | "releases";
type NavItem = { id: PageId; icon: IconName; label: string };
const navigation: Array<{ group: string; items: NavItem[] }> = [
  { group: "监控", items: [{ id: "overview", icon: "overview", label: "运维总览" }, { id: "topology", icon: "topology", label: "全球拓扑" }, { id: "logs", icon: "logs", label: "运行日志" }] },
  { group: "基础设施", items: [{ id: "nodes", icon: "nodes", label: "节点运维" }, { id: "services", icon: "services", label: "VPN 服务" }, { id: "regions", icon: "regions", label: "区域管理" }, { id: "controller", icon: "controller", label: "Controller" }] },
  { group: "用户", items: [{ id: "users", icon: "users", label: "账号管理" }, { id: "subscriptions", icon: "subscriptions", label: "订阅管理" }] },
  { group: "客户端", items: [{ id: "releases", icon: "download", label: "客户端发布" }] },
];
const pages = navigation.flatMap((section) => section.items.map((item) => ({ ...item, group: section.group })));
applyTheme();

function Brand() {
  useConsoleLanguage();
  return <div className="brand"><span className="mark"><BrandMark size={26} /></span><span>VEIL<em>BIRD</em> <small>CONSOLE</small></span></div>;
}

function Login({ onUser }: { onUser: (user: AdminUser) => void }) {
  useConsoleLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api<{ user: AdminUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if (!result.user?.id) throw new Error(t("登录接口返回异常，请检查 Console 的 /api/ 反向代理。"));
      onUser(result.user);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="login">
    <ConsoleLanguagePicker />
    <Brand />
    <form onSubmit={submit}>
      <h1>{t("管理控制台")}</h1><p>{t("账号审核、节点部署与修复、VPN 服务和运行诊断。")}</p>
      <label>{t("管理员邮箱")}<input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>{t("密码")}<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? t("登录中…") : t("登录 Console")} →</button>
      {error && <div className="login-error" role="alert">{error}</div>}
    </form>
  </main>;
}

function App() {
  useConsoleLanguage();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [controllerSettings, setControllerSettings] = useState<ControllerInfo["settings"] | null>(null);
  const route = useRoute();
  const page: PageId = pages.some((item) => item.id === route.page) ? route.page as PageId : "overview";
  const [theme, setTheme] = useTheme();
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
    } catch (reason) { if (!isUnauthorized(reason)) setError((reason as Error).message); }
    finally { setDataLoading(false); }
  }, []);

  const clearSession = useCallback(() => {
    setUser(null); setUsers([]); setNodes([]); setRegions([]); setControllerSettings(null); setMenuOpen(false); setError("");
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    api<{ user: AdminUser }>("/api/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { if (user) void refreshCore(); }, [user, refreshCore]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    clearSession();
  }
  // Close the mobile drawer and return to the top whenever the page itself changes (not on filter changes).
  useEffect(() => { setMenuOpen(false); window.scrollTo({ top: 0 }); }, [page]);

  if (loading) return <main className="loading"><Brand /><span>{t("正在连接控制面…")}</span></main>;
  if (!user) return <Login onUser={setUser} />;

  const current = pages.find((item) => item.id === page)!;
  const pendingUsers = users.filter((account) => account.status === "pending").length;
  return <main className="app-shell">
    <aside className={menuOpen ? "open" : ""}>
      <div className="aside-head"><Brand /><button className="icon-button mobile-only" aria-label={t("关闭菜单")} onClick={() => setMenuOpen(false)}><Icon name="close" /></button></div>
      <nav aria-label={t("管理控制台导航")}>{navigation.map((section) => <div className="nav-group" key={section.group}><p>{t(section.group)}</p>{section.items.map((item) => <a key={item.id} href={href(item.id)} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon name={item.icon} /><span>{t(item.label)}</span>{item.id === "users" && pendingUsers > 0 && <em title={t("{0} 个账号待审核", [pendingUsers])}>{pendingUsers}</em>}</a>)}</div>)}</nav>
      <div className="aside-health"><span className={`live-mark ${error ? "down" : ""}`} /><span><b>Controller API</b><small>{error ? t("连接异常") : dataLoading ? t("同步数据中") : t("已认证 · 运行中")}</small></span></div>
      <div className="aside-user"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><span><b>{user.displayName}</b><small>{user.email}</small></span><button className="icon-button" title={t("退出登录")} aria-label={t("退出登录")} onClick={() => void logout()}><Icon name="logout" size={16} /></button></div>
    </aside>
    {menuOpen && <button className="menu-scrim" aria-label={t("关闭菜单")} onClick={() => setMenuOpen(false)} />}
    <section className="workspace">
      <header className="topbar"><button className="icon-button mobile-only" aria-label={t("打开菜单")} onClick={() => setMenuOpen(true)}><Icon name="menu" /></button><div className="crumb"><span>{t(current.group)}</span><b>{t(current.label)}</b></div><span className="topbar-status">{dataLoading ? t("正在同步…") : t("{0}/{1} 节点在线", [nodes.filter((node) => node.status === "online").length, nodes.length])}</span><ConsoleLanguagePicker /><ThemeSwitch value={theme} onChange={setTheme} /></header>
      <div className="content">
        {error && <div className="inline-notice error" role="alert"><span>{error}</span><button className="text-button" onClick={() => void refreshCore()}>{t("重试")}</button></div>}
        <Suspense fallback={<div className="page-loading" role="status"><i /><i /><i /></div>}>
          {page === "overview" && <OverviewPage users={users} nodes={nodes} regions={regions} controllerSettings={controllerSettings} onRefresh={refreshCore} />}
          {page === "topology" && <TopologyPage nodes={nodes} regions={regions} controllerSettings={controllerSettings} onRefresh={refreshCore} />}
          {page === "users" && <UsersPage users={users} onRefresh={refreshCore} />}
          {page === "subscriptions" && <SubscriptionPanel api={api} admin />}
          {page === "nodes" && <NodesPage nodes={nodes} regions={regions} loading={dataLoading} onRefresh={refreshCore} />}
          {page === "services" && <ServicesPage nodes={nodes} />}
          {page === "regions" && <RegionsPage regions={regions} nodes={nodes} onRefresh={refreshCore} />}
          {page === "controller" && <ControllerPage onSettingsChange={setControllerSettings} />}
          {page === "logs" && <LogsPage nodes={nodes} />}
          {page === "releases" && <ReleasesPage />}
        </Suspense>
      </div>
    </section>
  </main>;
}

function ThemeSwitch({ value, onChange }: { value: ThemeChoice; onChange: (value: ThemeChoice) => void }) {
  useConsoleLanguage();
  const options: Array<[ThemeChoice, IconName, string]> = [["light", "sun", t("浅色")], ["dark", "moon", t("深色")], ["system", "monitor", t("跟随系统")]];
  return <div className="theme-switch" role="group" aria-label={t("界面主题")}>{options.map(([choice, icon, label]) => <button key={choice} type="button" className={value === choice ? "active" : ""} aria-pressed={value === choice} title={label} aria-label={label} onClick={() => onChange(choice)}><Icon name={icon} size={15} /></button>)}</div>;
}

createRoot(document.getElementById("root")!).render(<ConsoleLanguage><ConfirmProvider><ToastProvider><App /></ToastProvider></ConfirmProvider></ConsoleLanguage>);
