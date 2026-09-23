import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CredentialDashboard } from "./credential-dashboard";
import "./styles.css";
import "./profile-actions.css";
import "./region-map.css";
import "./ui-refinements.css";

type User = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  rejectionReason?: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(`API 返回了非 JSON 响应（HTTP ${response.status}），请检查 Portal 的 /api/ 反向代理。`);
  }
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw Object.assign(
      new Error(typeof body.error === "string" ? body.error : `请求失败（HTTP ${response.status}）`),
      { body, status: response.status },
    );
  }
  return body as T;
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>NORTHSTAR <em>VPN</em></span></div>;
}

function Auth({ mode, onMode, onUser }: {
  mode: "login" | "register";
  onMode: (mode: "login" | "register") => void;
  onUser: (user: User) => void;
}) {
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; message?: string }>(
        mode === "login" ? "/api/v1/auth/web-login" : "/api/v1/auth/register",
        { method: "POST", body: JSON.stringify(form) },
      );
      if (!result.user?.id) throw new Error("登录接口返回异常，请检查 Portal 的 /api/ 反向代理。");
      onUser(result.user);
    } catch (caught) {
      const requestError = caught as Error & { body?: { user?: User } };
      if (requestError.body?.user) onUser(requestError.body.user);
      else setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-layout">
    <section className="auth-intro">
      <Brand />
      <p className="kicker">PRIVATE NETWORK FOR PEOPLE AROUND YOU</p>
      <h1>连接到你<br /><span>信任的网络。</span></h1>
      <p className="intro-copy">账号审核通过后，即可创建独立命名的 WireGuard 或 OpenVPN 连接凭据。简单、透明，不做复杂套餐。</p>
      <div className="trust"><span>●</span><div><b>人工审核</b><small>仅限受邀和熟悉的用户使用</small></div></div>
    </section>
    <form className="auth-panel" onSubmit={submit}>
      <p className="kicker">{mode === "login" ? "WELCOME BACK" : "REQUEST ACCESS"}</p>
      <h2>{mode === "login" ? "登录 Northstar" : "申请使用 VPN"}</h2>
      <p className="muted">{mode === "login" ? "使用已审核的账号继续。" : "提交后由管理员人工审核。"}</p>
      {mode === "register" && <label>称呼<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="例如：小王" /></label>}
      <label>邮箱<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
      <label>密码<input type="password" minLength={12} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="至少 12 位" /></label>
      <button className="primary" disabled={busy}>{busy ? "处理中…" : mode === "login" ? "登录" : "提交申请"}<span>→</span></button>
      {error && <p className="error">{error}</p>}
      <button type="button" className="text-button" onClick={() => onMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "还没有账号？申请使用" : "已有账号？返回登录"}</button>
    </form>
  </main>;
}

function Pending({ user, onLogout }: { user: User; onLogout: () => void }) {
  return <main className="center-page"><Brand /><div className="status-card">
    <span className="status-icon">…</span>
    <p className="kicker">APPLICATION RECEIVED</p>
    <h1>等待管理员审核</h1>
    <p>账号 <b>{user.email}</b> 已提交。审核通过后即可登录并创建 VPN 连接凭据。</p>
    {user.status === "rejected" && <p className="error">申请未通过：{user.rejectionReason || "请联系管理员"}</p>}
    <button className="secondary" onClick={onLogout}>返回</button>
  </div></main>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api<{ user: User }>("/api/v1/auth/me")
        .then((result) => setUser(result.user))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/web-logout", { method: "POST", credentials: "include" });
    setUser(null);
    setMode("login");
  }

  if (loading) return <main className="center-page"><Brand /><p>正在连接 Northstar…</p></main>;
  if (!user) return <Auth mode={mode} onMode={setMode} onUser={setUser} />;
  if (user.status !== "active") return <Pending user={user} onLogout={() => void logout()} />;
  return <CredentialDashboard user={user} onLogout={() => void logout()} />;
}

createRoot(document.getElementById("root")!).render(<App />);
