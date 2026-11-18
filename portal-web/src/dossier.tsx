import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../shared/i18n";
import { api } from "./api";

const GLYPHS = "01ABCDEF#%/<>*+=";
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * One line of a file: plain text, or "sealed" as a dim dot matrix. Sealing and unsealing first runs the text
 * through a few frames of random glyphs (amber), so the change is seen, then settles. Width never changes.
 */
export function SealedText({ text, sealed, delay = 0, className = "" }: { text: string; sealed: boolean; delay?: number; className?: string }) {
  // The state the line last settled in; while it differs from `sealed` the line waits for its turn, then scrambles.
  const [settled, setSettled] = useState(sealed);
  const [scramble, setScramble] = useState<string | null>(null);
  useEffect(() => {
    if (settled === sealed) return;
    let frame = 0, interval = 0;
    const start = window.setTimeout(() => {
      if (reduced()) { setSettled(sealed); return; }
      interval = window.setInterval(() => {
        frame += 1;
        if (frame >= 11) { window.clearInterval(interval); setScramble(null); setSettled(sealed); return; }
        setScramble([...text].map((c) => (c === " " || c === "·") ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join(""));
      }, 42);
    }, reduced() ? 0 : delay);
    // Toggled back mid-way: drop the scramble, the line shows the state it last settled in.
    return () => { window.clearTimeout(start); window.clearInterval(interval); if (frame > 0) setScramble(null); };
  }, [sealed, settled, text, delay]);
  const busy = scramble !== null;
  const dots = !busy && settled;
  return <span className={`sealed-text${dots ? " sealed" : ""}${busy ? " scrambling" : ""} ${className}`} aria-hidden={dots || undefined}>{scramble ?? text}</span>;
}

type Row = { key: string; label: string; value: string };

function describeBrowser() {
  const ua = navigator.userAgent;
  const browser = /Edg\/(\d+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
    : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : /Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` : "—";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}
function describeZone() {
  const minutes = -new Date().getTimezoneOffset(), sign = minutes >= 0 ? "+" : "-", abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The sign-in page's "visitor file": what this very page can read about whoever opened it (public address from the
 * server, browser, time zone, screen, language). Nothing is stored. "Seal" plays the apps' connect moment: a line of
 * light sweeps down the file and each line it crosses turns into dots; again unseals it, sweeping back up.
 */
export function VisitorFile() {
  const { t } = useI18n();
  const [ip, setIp] = useState<string | null | undefined>(undefined);
  const [sealed, setSealed] = useState(false);
  const [sweep, setSweep] = useState<"down" | "up" | "">("");
  const timer = useRef(0);
  useEffect(() => {
    void api<{ ip: string | null }>("/api/v1/visitor").then((result) => setIp(result.ip)).catch(() => setIp(null));
    return () => window.clearTimeout(timer.current);
  }, []);
  const rows: Row[] = [
    { key: "ip", label: t("出口 IP"), value: ip === undefined ? "···" : ip || "—" },
    { key: "browser", label: t("浏览器"), value: describeBrowser() },
    { key: "zone", label: t("时区"), value: describeZone() },
    { key: "screen", label: t("屏幕"), value: `${window.screen.width} × ${window.screen.height}` },
    { key: "lang", label: t("语言"), value: navigator.language || "—" },
  ];
  const STEP = 170, DURATION = 1300;
  function toggle() {
    const next = !sealed;
    setSealed(next);
    if (reduced()) return;
    setSweep(""); window.clearTimeout(timer.current);
    window.requestAnimationFrame(() => setSweep(next ? "down" : "up"));
    timer.current = window.setTimeout(() => setSweep(""), DURATION + 100);
  }
  const delay = (index: number) => 120 + (sealed ? index : rows.length - 1 - index) * STEP;
  return <section className={`visitor-file${sealed ? " is-sealed" : ""}`} aria-label={t("访客档案")}>
    <div className="file-head"><span className="file-label">{t("§ 访客档案 · 此刻")}</span>
      <b className="file-state"><span className="when-off">{t("未隐匿")}</span><span className="when-on">{t("已封存")}<span className="stamp">SEALED</span></span></b></div>
    <div className="file-rows">
      {sweep && <span className={`file-scan ${sweep}`} aria-hidden="true" />}
      {rows.map((row, index) => <div key={row.key} className="file-row"><span className="file-key">{row.label}</span><SealedText text={row.value} sealed={sealed} delay={delay(index)} /></div>)}
    </div>
    <div className="file-foot"><span className="file-label">{sealed ? t("装上客户端之后，就是这样。") : t("这些信息此刻就能被任何网站读取。")}</span>
      <button type="button" className="file-action" onClick={toggle} aria-pressed={sealed}>{sealed ? t("解封") : t("演示封存")} →</button></div>
  </section>;
}

/** A short, stable file number for a signed-in account (shown as № 0427), derived from the email; not an id. */
export function fileNumber(seed: string) {
  let hash = 7;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return String(hash % 10000).padStart(4, "0");
}
