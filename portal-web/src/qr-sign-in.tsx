import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";
import { useI18n } from "../../shared/i18n";

type Created = { id: string; secret: string; qr: string; ttl: number };
type Phase = "loading" | "pending" | "scanned" | "expired" | "declined" | "unavailable";

/**
 * Beside the password form on a wide screen: a QR the phone app scans (我的 → 扫码登录电脑) and confirms. The page
 * asks every two seconds; once the phone confirms, the answer sets the session cookie and the page loads the account.
 * The code lives two minutes; after that, one tap makes a new one.
 */
export function QrSignIn<User>({ onUser }: { onUser: (user: User) => void }) {
  const { t } = useI18n();
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");
  const [image, setImage] = useState("");
  const signedIn = useRef(onUser);
  useEffect(() => { signedIn.current = onUser; }, [onUser]);

  useEffect(() => {
    let live = true, timer = 0;
    const poll = async (created: Created, until: number) => {
      if (!live) return;
      if (Date.now() > until) { setPhase("expired"); return; }
      try {
        const result = await api<{ status: string }>("/api/v1/auth/qr-login/poll", { method: "POST", body: JSON.stringify({ id: created.id, secret: created.secret }) });
        if (!live) return;
        if (result.status === "approved") {
          const me = await api<{ user: User }>("/api/v1/auth/me");
          if (live && me.user) signedIn.current(me.user);
          return;
        }
        if (result.status === "expired" || result.status === "declined") { setPhase(result.status); return; }
        setPhase(result.status === "scanned" ? "scanned" : "pending");
      } catch { /* the next round tries again */ }
      timer = window.setTimeout(() => void poll(created, until), 2000);
    };
    void (async () => {
      try {
        const created = await api<Created>("/api/v1/auth/qr-login", { method: "POST", body: JSON.stringify({ deviceName: browserName() }) });
        const src = await QRCode.toDataURL(created.qr, { margin: 1, width: 360, errorCorrectionLevel: "M" });
        if (!live) return;
        setImage(src); setPhase("pending");
        timer = window.setTimeout(() => void poll(created, Date.now() + created.ttl * 1000), 2000);
      } catch { if (live) setPhase("unavailable"); }
    })();
    return () => { live = false; window.clearTimeout(timer); };
  }, [round]);

  if (phase === "unavailable") return null;
  const over = phase === "expired" || phase === "declined";
  return <aside className="qr-sign-in" aria-live="polite">
    <div className={`qr-sign-in-code${over || phase === "scanned" ? " faded" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Vite app, data: URL generated locally */}
      {image ? <img src={image} alt={t("扫码登录二维码")} width={132} height={132} /> : <span className="qr-sign-in-blank" />}
      {over && <button type="button" className="secondary compact" onClick={() => { setPhase("loading"); setImage(""); setRound(round + 1); }}>{t("刷新")}</button>}
    </div>
    <div className="qr-sign-in-text">
      <b>{phase === "scanned" ? t("已扫码，请在手机上确认") : over ? t(phase === "declined" ? "手机上已取消" : "二维码已过期") : t("用手机扫码登录")}</b>
      <span className="muted">{t("打开手机 App，在「我的」里点「扫码登录电脑」。")}</span>
    </div>
  </aside>;
}

function browserName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const system = /Windows/.test(agent) ? "Windows" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "";
  return [browser, system].filter(Boolean).join(" · ");
}
