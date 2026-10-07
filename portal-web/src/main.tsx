import { useI18n } from "../../shared/i18n";
import { Brand } from "./brand";
import { PortalLanguage, PortalLanguagePicker } from "./language";
import "./language.css";
import { errorText } from "../../shared/i18n-errors";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { CredentialDashboard } from "./credential-dashboard";
import "./styles.css";
import "./region-map.css";

type User = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  rejectionReason?: string | null;
};

export 
function Auth({ mode, onMode, onUser }: {
  mode: "login" | "register";
  onMode: (mode: "login" | "register") => void;
  onUser: (user: User) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") {
        // Registration never says whether the email already exists, so show the review screen for this address.
        await api<{ status: string }>("/api/v1/auth/register", { method: "POST", body: JSON.stringify(form) });
        onUser({ id: "", email: form.email.trim().toLowerCase(), displayName: form.displayName, role: "user", status: "pending" });
        return;
      }
      const result = await api<{ user: User; message?: string }>("/api/v1/auth/web-login", { method: "POST", body: JSON.stringify(form) });
      if (!result.user?.id) throw new Error(t("登录接口返回异常，请检查 Portal 的 /api/ 反向代理。"));
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
      <h1>{t("连接到你")}<br /><span>{t("信任的网络。")}</span></h1>
      <p className="intro-copy">{t("审核通过后一键创建订阅，导入客户端或扫码即用。")}</p>
      <ul className="trust"><li><b>{t("一份订阅，全部节点")}</b><small>{t("客户端里随时切换，新节点自动出现")}</small></li><li><b>{t("人工审核")}</b><small>{t("仅限受邀和熟悉的用户使用")}</small></li></ul>
    </section>
    <form className="auth-panel" onSubmit={submit}>
      <h2>{mode === "login" ? t("登录 Veilbird") : t("申请使用 VPN")}</h2>
      <p className="muted">{mode === "login" ? t("使用已审核的账号继续，获取你的订阅链接。") : t("提交后由管理员人工审核。")}</p>
      {mode === "register" && <label>{t("称呼")}<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder={t("例如：小王")} /></label>}
      <label>{t("邮箱")}<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
      <label>{t("密码")}<input type="password" minLength={12} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={t("至少 12 位")} /></label>
      {error && <p className="inline-error" role="alert">{errorText(error, t)}</p>}
      <button className="primary large wide" disabled={busy}>{busy ? t("处理中…") : mode === "login" ? t("登录") : t("提交申请")}</button>
      <button type="button" className="ghost wide" onClick={() => onMode(mode === "login" ? "register" : "login")}>{mode === "login" ? t("还没有账号？申请使用") : t("已有账号？返回登录")}</button>
    </form>
  </main>;
}

function Pending({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t } = useI18n();
  return <main className="center-page"><Brand /><div className="status-card">
    <span className="status-icon">…</span>
    <h1>{t("等待管理员审核")}</h1>
    <p>{t("账号")} <b>{user.email}</b> {t("已提交。审核通过后即可登录，一键创建订阅。")}</p>
    {!user.id && <p className="muted">{t("如果这个邮箱之前已经注册过，请直接返回登录。")}</p>}
    {user.status === "rejected" && <p className="inline-error">{t("申请未通过：")}{user.rejectionReason || t("请联系管理员")}</p>}
    <button className="secondary" onClick={onLogout}>{t("返回")}</button>
  </div></main>;
}

export default function App() {
  const { t } = useI18n();
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
    await fetch("/api/v1/auth/web-logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setUser(null);
    setMode("login");
  }

  if (user?.status === "active" && !loading) return <CredentialDashboard user={user} onLogout={() => void logout()} />;
  return <><PortalLanguagePicker floating />{loading ? <main className="center-page" aria-busy="true"><Brand /><span className="loader" aria-label={t("正在连接 Veilbird…")} /></main>
    : !user ? <Auth mode={mode} onMode={setMode} onUser={setUser} /> : <Pending user={user} onLogout={() => void logout()} />}</>;
}

createRoot(document.getElementById("root")!).render(<PortalLanguage><App /></PortalLanguage>);
