import { useI18n } from "../../shared/i18n";
import { Brand } from "./brand";
import { BrandMark } from "../../shared/brand";
import { PasswordInput } from "../../shared/password-input";
import { applySiteToDocument, loadSite, useSite } from "../../shared/site";
import { PRODUCT_NAME } from "../../shared/brand-name";
import { PortalLanguage, PortalLanguagePicker } from "./language";
import "./language.css";
import { errorText } from "../../shared/i18n-errors";
import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { DataStream } from "./pixel";
import "./styles.css";
import "./region-map.css";

// Signed-in pages load on demand, so the sign-in screen does not wait for them (or for the QR code library).
const loadHome = () => import("./home");
const loadDashboard = () => import("./credential-dashboard");
const Home = lazy(() => loadHome().then((module) => ({ default: module.Home })));
const CredentialDashboard = lazy(() => loadDashboard().then((module) => ({ default: module.CredentialDashboard })));

type User = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  rejectionReason?: string | null;
};

type AuthMode = "login" | "register" | "forgot";

export 
function Auth({ mode, onMode, onUser, notice }: {
  mode: AuthMode;
  onMode: (mode: AuthMode) => void;
  onUser: (user: User) => void;
  notice?: string;
}) {
  const { locale, t } = useI18n();
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetByEmail, setResetByEmail] = useState<boolean | null>(null);
  const [resetSent, setResetSent] = useState(false);

  function switchMode(next: AuthMode) {
    setError(""); setResetSent(false); onMode(next);
    if (next === "forgot" && resetByEmail === null) void api<{ email: boolean }>("/api/v1/auth/password-reset").then((result) => setResetByEmail(result.email)).catch(() => setResetByEmail(false));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        await api("/api/v1/auth/password-reset", { method: "POST", body: JSON.stringify({ email: form.email, language: locale }) });
        setResetSent(true);
        return;
      }
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

  const site = useSite(), siteName = site?.name || PRODUCT_NAME;
  // Only the default site has its own apps; other sites still hand out subscriptions.
  const apps = site?.isDefault !== false;
  const title = mode === "login" ? t("登录 {0}", [siteName]) : mode === "register" ? t("申请使用 VPN") : t("找回密码");
  const subtitle = mode === "login" ? apps ? t("登录后下载客户端，用同一账号即可使用。") : t("使用已审核的账号继续，获取你的订阅链接。") : mode === "register" ? t("提交后由管理员人工审核。")
    : resetSent ? t("如果该邮箱已注册，重置链接很快会发到邮箱，1 小时内有效。")
      : resetByEmail === false ? t("请联系管理员，为你生成重置密码的链接。") : t("输入注册邮箱，我们会发送重置链接。");
  const askEmail = mode !== "forgot" || (resetByEmail && !resetSent);

  return <main className="auth-layout">
    <section className="auth-intro">
      <Brand />
      {/* The approved sign-in art: the mark large over a halftone field, the data stream under it. */}
      <div className="auth-art" aria-hidden="true">
        <span className="auth-mark"><BrandMark size={176} logoSvg={site?.logoSvg} /></span>
        <span className="home-stream"><DataStream /><DataStream count={12} salt={1} className="dim" /></span>
      </div>
      <p className="intro-copy">{apps ? t("审核通过后，下载客户端登录即可使用，无需导入配置。") : t("审核通过后一键创建订阅，导入客户端或扫码即用。")}</p>
    </section>
    <form className="auth-panel" onSubmit={submit}>
      <h2>{title}</h2>
      <p className="muted" aria-live="polite">{subtitle}</p>
      {notice && mode === "login" && <p className="inline-success" role="status">{notice}</p>}
      {mode === "register" && <label>{t("称呼")}<input required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder={t("例如：小王")} /></label>}
      {askEmail && <label>{t("邮箱")}<input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>}
      {mode !== "forgot" && <div className="field">
        <div className="field-head"><label htmlFor="auth-password">{t("密码")}</label>{mode === "login" && <button type="button" className="ghost compact" onClick={() => switchMode("forgot")}>{t("忘记密码？")}</button>}</div>
        <PasswordInput showLabel={t("显示密码")} hideLabel={t("隐藏密码")} id="auth-password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={12} required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={t("至少 12 位")} />
      </div>}
      {error && <p className="inline-error" role="alert">{errorText(error, t)}</p>}
      {askEmail && <button className="primary large wide" disabled={busy}>{busy ? t("处理中…") : mode === "login" ? t("登录") : mode === "register" ? t("提交申请") : t("发送重置链接")}</button>}
      {mode === "forgot" ? <button type="button" className={`${askEmail ? "ghost" : "secondary"} wide`} onClick={() => switchMode("login")}>{t("返回登录")}</button>
        : <button type="button" className="ghost wide" onClick={() => switchMode(mode === "login" ? "register" : "login")}>{mode === "login" ? t("还没有账号？申请使用") : t("已有账号？返回登录")}</button>}
    </form>
  </main>;
}

/** Opened from a reset link (/#reset=…). The token stays in the fragment so it never reaches server logs. */
function ResetPassword({ token, onDone }: { token: string; onDone: (changed: boolean) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/v1/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password }) });
      onDone(true);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  return <main className="center-page"><Brand /><form className="auth-panel" onSubmit={submit}>
    <h2>{t("设置新密码")}</h2>
    <p className="muted">{t("设置后，所有设备需要用新密码重新登录。")}</p>
    <label>{t("新密码")}<PasswordInput showLabel={t("显示密码")} hideLabel={t("隐藏密码")} autoComplete="new-password" minLength={12} required autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("至少 12 位")} /></label>
    {error && <p className="inline-error" role="alert">{errorText(error, t)}</p>}
    <button className="primary large wide" disabled={busy}>{busy ? t("处理中…") : t("保存新密码")}</button>
    <button type="button" className="ghost wide" onClick={() => onDone(false)}>{t("返回登录")}</button>
  </form></main>;
}

function Pending({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t } = useI18n();
  return <main className="center-page"><Brand /><div className="status-card">
    <span className="status-icon">…</span>
    <h1>{t("等待管理员审核")}</h1>
    <p>{t("账号")} <b>{user.email}</b> {t("已提交。审核通过后即可登录使用。")}</p>
    {!user.id && <p className="muted">{t("如果这个邮箱之前已经注册过，请直接返回登录。")}</p>}
    {user.status === "rejected" && <p className="inline-error">{t("申请未通过：")}{user.rejectionReason || t("请联系管理员")}</p>}
    <button className="secondary" onClick={onLogout}>{t("返回")}</button>
  </div></main>;
}

const readResetToken = () => /^#reset=([\w.-]+)$/.exec(window.location.hash)?.[1] || "";
const readManual = () => window.location.hash === "#manual";

export default function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<AuthMode>("login");
  const [loading, setLoading] = useState(true);
  const [resetToken, setResetToken] = useState(readResetToken);
  const [notice, setNotice] = useState("");
  const [manual, setManual] = useState(readManual);
  const site = useSite();

  useEffect(() => {
    const follow = () => { const token = readResetToken(); if (token) setResetToken(token); setManual(readManual()); };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  function finishReset(changed: boolean) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setResetToken(""); setUser(null); setMode("login");
    setNotice(changed ? t("密码已更新，请用新密码登录。") : "");
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // The site (name, logo) loads alongside the session so the first screen already shows the right brand.
      void Promise.all([
        api<{ user: User }>("/api/v1/auth/me").then((result) => {
          // Fetch the signed-in page while the site settings are still loading.
          if (result.user?.status === "active") void (readManual() ? loadDashboard() : loadHome()).catch(() => undefined);
          setUser(result.user);
        }).catch(() => undefined),
        loadSite().then((site) => applySiteToDocument(site)),
      ]).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/web-logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setUser(null);
    setMode("login");
  }

  const connecting = <main className="center-page" aria-busy="true"><Brand /><span className="loader" aria-label={t("正在连接…")} /></main>;
  if (resetToken) return <><PortalLanguagePicker floating /><ResetPassword token={resetToken} onDone={finishReset} /></>;
  if (user?.status === "active" && !loading) {
    // #manual keeps the browser's Back button working between the two pages.
    const go = (next: boolean) => { if (next) window.location.hash = "manual"; else window.history.replaceState(null, "", window.location.pathname + window.location.search); setManual(next); window.scrollTo(0, 0); };
    // The apps are built for the default site only; other sites keep subscriptions as their home.
    const page = site?.isDefault === false ? <CredentialDashboard user={user} onLogout={() => void logout()} />
      : manual ? <CredentialDashboard user={user} onLogout={() => void logout()} onBack={() => go(false)} /> : <Home user={user} onLogout={() => void logout()} onManual={() => go(true)} />;
    return <Suspense fallback={connecting}>{page}</Suspense>;
  }
  return <><PortalLanguagePicker floating />{loading ? connecting
    : !user ? <Auth mode={mode} onMode={setMode} onUser={setUser} notice={notice} /> : <Pending user={user} onLogout={() => void logout()} />}</>;
}

createRoot(document.getElementById("root")!).render(<PortalLanguage><App /></PortalLanguage>);
