import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../shared/i18n";
import { LAND_MASK } from "./land-mask";

/** A place on the globe, with the name shown beside it. */
export type Spot = { lat: number; lon: number; label: string };
type Phase = "idle" | "connecting" | "connected";
type View = { lat: number; lon: number };

const D = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** The land mask, 720×360 bits, as a 360×180 soft mask (2×2 average, 3×3 blur, no Antarctica); built on first use. */
let mask: Float32Array | null = null;
function land(lat: number, lon: number) {
  if (!mask) {
    const bytes = atob(LAND_MASK), W = 720, w = 360, h = 180;
    const bit = (i: number) => (bytes.charCodeAt(i >> 3) >> (i & 7)) & 1;
    const m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) a += bit((2 * y + dy) * W + 2 * x + dx);
      m[y * w + x] = y >= 152 ? 0 : a / 4;
    }
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let t = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { t += m[yy * w + (x + dx + w) % w]; n++; } }
      o[y * w + x] = t / n;
    }
    mask = o;
  }
  let fx = lon + 180 - 0.5; fx = ((fx % 360) + 360) % 360;
  const fy = clamp(90 - lat - 0.5, 0, 179);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = (x0 + 1) % 360, y1 = Math.min(179, y0 + 1), tx = fx - x0, ty = fy - y0, M = mask;
  return (M[y0 * 360 + x0] * (1 - tx) + M[y0 * 360 + x1] * tx) * (1 - ty) + (M[y1 * 360 + x0] * (1 - tx) + M[y1 * 360 + x1] * tx) * ty;
}
/** The halftone light of the apps' sphere: bright at the upper left, falling off to nothing at the far limb. */
const light = (f: number) => f < .22 ? 1 - f / .22 * .15 : f < .48 ? .85 - (f - .22) / .26 * .5 : f < .66 ? .35 - (f - .48) / .18 * .27 : f < .72 ? .08 - (f - .66) / .06 * .08 : 0;
const vec = (lat: number, lon: number) => [Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D), Math.cos(lat * D) * Math.cos(lon * D)];
function angle(a: View, b: View) { const A = vec(a.lat, a.lon), B = vec(b.lat, b.lon); return Math.acos(clamp(A[0] * B[0] + A[1] * B[1] + A[2] * B[2], -1, 1)); }
function slerp(a: View, b: View, t: number): View {
  const w = angle(a, b);
  if (w < 1e-6) return a;
  const A = vec(a.lat, a.lon), B = vec(b.lat, b.lon), s = Math.sin(w), k1 = Math.sin((1 - t) * w) / s, k2 = Math.sin(t * w) / s;
  const v = [A[0] * k1 + B[0] * k2, A[1] * k1 + B[1] * k2, A[2] * k1 + B[2] * k2], n = Math.hypot(v[0], v[1], v[2]);
  return { lat: Math.asin(v[1] / n) / D, lon: Math.atan2(v[0], v[2]) / D };
}
export const km = (a: View, b: View) => angle(a, b) * 6371;
/** Orthographic projection: unit-disk x, y (y up) and depth z (> 0 is the near side); h lifts the point off the surface. */
function project(lat: number, lon: number, h: number, v: View) {
  const p = lat * D, l = lon * D, p0 = v.lat * D, l0 = v.lon * D, c = Math.cos(p), k = 1 + h;
  return { x: c * Math.sin(l - l0) * k, y: (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * c * Math.cos(l - l0)) * k, z: Math.sin(p0) * Math.sin(p) + Math.cos(p0) * c * Math.cos(l - l0) };
}
function unproject(nx: number, ny: number, v: View): View {
  const r = Math.hypot(nx, ny);
  if (r < 1e-9) return v;
  const c = Math.asin(Math.min(1, r)), p0 = v.lat * D;
  const lat = Math.asin(Math.cos(c) * Math.sin(p0) + ny * Math.sin(c) * Math.cos(p0) / r);
  const lon = v.lon * D + Math.atan2(nx * Math.sin(c), r * Math.cos(c) * Math.cos(p0) - ny * Math.sin(c) * Math.sin(p0));
  return { lat: lat / D, lon: lon / D };
}

const COLOR = { light: [255, 214, 160], accent: [224, 164, 88], text: [237, 231, 223] } as const;
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1)})`;

/** Where the globe looks: idle, a little below this device; on, the middle of the route, low enough that the arc fits. */
function aim(phase: Phase, origin: Spot | null, exit: Spot | null): View {
  if (phase === "idle" || !exit) { const p = origin ?? exit; return p ? { lat: clamp(p.lat - 14, -55, 55), lon: p.lon } : { lat: 18, lon: 100 }; }
  if (!origin) return { lat: clamp(exit.lat - 12, -55, 55), lon: exit.lon - 22 };
  const m = slerp(origin, exit, .5), w = angle(origin, exit) / D;
  return { lat: clamp(m.lat - 8 - w * .12, -55, 55), lon: m.lon };
}

/** The still globe (dots of land and sea under the halftone light), drawn once per size and view. */
function sphere(cache: { key: string; canvas: HTMLCanvasElement | null }, S: number, v: View) {
  const key = `${S}|${v.lat.toFixed(2)}|${v.lon.toFixed(2)}`;
  if (cache.canvas && cache.key === key) return cache.canvas;
  const canvas = cache.canvas ?? document.createElement("canvas");
  canvas.width = canvas.height = Math.ceil(S);
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const pitch = S * 6 / 320, r = S * 1.15 / 320, R = S / 2, lx = S * .42, ly = S * .34;
  for (let y = pitch / 2; y < S; y += pitch) for (let x = pitch / 2; x < S; x += pitch) {
    const nx = (x - R) / R, ny = (R - y) / R, d = nx * nx + ny * ny;
    if (d > 1) continue;
    const z = Math.sqrt(1 - d), at = unproject(nx, ny, v), l = land(at.lat, at.lon);
    const a = light(Math.hypot(x - lx, y - ly) / (S * .98)), limb = Math.min(1, z / .18);
    const alpha = (l * (.3 + .5 * a) + (1 - l) * (.025 + .08 * a)) * limb;
    if (alpha < .02) continue;
    g.fillStyle = rgba(COLOR.light, alpha);
    g.beginPath(); g.arc(x, y, r * (.72 + .32 * l), 0, Math.PI * 2); g.fill();
  }
  cache.key = key; cache.canvas = canvas;
  return canvas;
}

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The hero's globe, the same drawing as the apps' home (Android Globe.kt): a dim dot globe lit from the upper left, a
 * light pin where this page sees you, rippling. A tap (and once on its own, shortly after the page opens) plays one
 * connection: the globe turns to frame both ends, a comet runs the dotted arc, then it lands on the nearest exit with a
 * flash and two rings and settles, and after a few seconds it turns back. Still under reduced motion and in hidden tabs.
 */
export function HeroGlobe({ exits }: { exits: Spot[] }) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const [origin, setOrigin] = useState<Spot | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [played, setPlayed] = useState(0);
  const state = useRef({ phase: "idle" as Phase, since: 0, view: null as View | null, from: null as View | null, to: null as View | null, turnAt: 0, cache: { key: "", canvas: null as HTMLCanvasElement | null } });

  useEffect(() => {
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
    const controller = new AbortController();
    fetch(`/api/v1/visitor?zone=${encodeURIComponent(zone)}`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((body: { place?: { lat?: number; lon?: number; names?: Record<string, string> } | null } | null) => {
        const place = body?.place;
        if (place && typeof place.lat === "number" && typeof place.lon === "number") setOrigin({ lat: place.lat, lon: place.lon, label: place.names?.[locale] || place.names?.en || "" });
      }).catch(() => undefined);
    return () => controller.abort();
  }, [locale]);

  // The demo goes to the nearest exit that is not next door (a route of a few kilometres draws nothing).
  const exit = (() => {
    if (!exits.length) return null;
    if (!origin) return exits[0];
    const sorted = [...exits].sort((a, b) => km(origin, a) - km(origin, b));
    return sorted.find((spot) => km(origin, spot) >= 300) ?? sorted[0];
  })();

  // One connection: connecting 1.6 s, connected 6 s, then back. The first plays on its own once the page settles.
  useEffect(() => {
    if (!exit) return;
    if (played === 0 && reducedMotion()) return;
    const timers = [
      window.setTimeout(() => setPhase("connecting"), played === 0 ? 1800 : 0),
      window.setTimeout(() => setPhase("connected"), (played === 0 ? 1800 : 0) + 1600),
      window.setTimeout(() => setPhase("idle"), (played === 0 ? 1800 : 0) + 7600),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [played, exit?.label]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const s = state.current, now = performance.now(), target = aim(phase, origin, exit);
    if (s.phase !== phase) { s.phase = phase; s.since = now; }
    if (!s.view) s.view = target;
    else if (Math.abs(target.lat - s.view.lat) > .01 || Math.abs(target.lon - s.view.lon) > .01) {
      s.from = { ...s.view }; s.to = { lat: target.lat, lon: s.view.lon + ((((target.lon - s.view.lon) + 540) % 360) - 180) }; s.turnAt = now;
    }
    const still = reducedMotion();
    let frame = 0, last = 0;
    const draw = (time: number) => {
      frame = 0;
      if (!document.hidden && time - last >= 32) { last = time; paint(canvas, s, time, origin, exit, still); }
      // Idle the ripple keeps going; on, the light runs the arc. Under reduced motion one frame is enough.
      if (!still) frame = requestAnimationFrame(draw);
      else if (s.to) frame = requestAnimationFrame(draw);
    };
    paint(canvas, s, now, origin, exit, still);
    frame = requestAnimationFrame(draw);
    const resize = new ResizeObserver(() => paint(canvas, s, performance.now(), origin, exit, still));
    resize.observe(canvas);
    return () => { if (frame) cancelAnimationFrame(frame); resize.disconnect(); };
  }, [phase, origin, exit?.label, exit?.lat, exit?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  return <button type="button" className="hero-globe" aria-label={t("演示一次连接")} title={t("演示一次连接")}
    disabled={!exit} onClick={() => { if (phase === "idle") setPlayed((n) => n + 1); }}>
    <canvas ref={ref} aria-hidden="true" />
  </button>;
}

function paint(canvas: HTMLCanvasElement, s: { phase: Phase; since: number; view: View | null; from: View | null; to: View | null; turnAt: number; cache: { key: string; canvas: HTMLCanvasElement | null } }, now: number, origin: Spot | null, exit: Spot | null, still: boolean) {
  const box = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  if (s.to && s.from) {
    const k = still ? 1 : clamp((now - s.turnAt) / (s.phase === "idle" ? 800 : 1200), 0, 1), e = ease(k);
    s.view = { lat: s.from.lat + (s.to.lat - s.from.lat) * e, lon: s.from.lon + (s.to.lon - s.from.lon) * e };
    if (k >= 1) s.to = null;
  }
  const v = s.view!, phase = s.phase, T = (now - s.since) / 1000, clock = now / 1000;
  const S = Math.min(W, H) * .94, cx = W / 2, cy = H / 2, R = S / 2, u = S / 320;
  const breath = .5 - .5 * Math.cos(clock / 3 * Math.PI * 2);
  const on = phase === "connected", busy = phase === "connecting";
  const dim = on ? .55 : busy ? .6 : .8 + (still ? 0 : .12 * breath);
  g.globalAlpha = dim; g.drawImage(sphere(s.cache, S, v), cx - R, cy - R); g.globalAlpha = 1;
  const glow = g.createRadialGradient(cx, cy, R, cx, cy, R * 1.09);
  glow.addColorStop(0, rgba(COLOR.light, .045 * dim)); glow.addColorStop(1, rgba(COLOR.light, 0));
  g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R * 1.09, 0, Math.PI * 2); g.moveTo(cx + R, cy); g.arc(cx, cy, R, 0, Math.PI * 2, true); g.fill();
  const screen = (p: { x: number; y: number; z: number }) => ({ x: cx + p.x * R, y: cy - p.y * R, vis: p.z > 0 || Math.hypot(p.x, p.y) > 1 });
  const halo = (x: number, y: number, radius: number, color: readonly number[], alpha: number) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, radius); gr.addColorStop(0, rgba(color, alpha)); gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, radius, 0, Math.PI * 2); g.fill();
  };
  const B = exit ? screen(project(exit.lat, exit.lon, 0, v)) : null;

  // The route: a dotted arc lifted off the surface, flattened until it stays in frame.
  if ((on || busy) && exit && B) {
    const A = origin ?? unproject(-.97, -.05, v);
    let lift = Math.max(.07, .09 + .3 * angle(A, exit) / Math.PI), arc: { x: number; y: number; vis: boolean; t: number }[] = [];
    for (let pass = 0; pass < 4; pass++) {
      arc = []; let reach = 0;
      for (let i = 0; i <= 96; i++) { const t = i / 96, p = slerp(A, exit, t), q = project(p.lat, p.lon, lift * Math.sin(Math.PI * t), v); arc.push({ ...screen(q), t }); reach = Math.max(reach, Math.hypot(q.x, q.y)); }
      if (reach < 1.03 || lift < .04) break;
      lift *= .7;
    }
    const dots: typeof arc = []; let run = 0;
    for (let i = 1; i < arc.length; i++) { run += Math.hypot(arc[i].x - arc[i - 1].x, arc[i].y - arc[i - 1].y); if (run >= 6.4 * u || i === 1) { run = 0; dots.push(arc[i]); } }
    const charge = on ? (still ? 1 : clamp(T / .7, 0, 1)) : 1, head = still ? -1 : busy ? (T / 1.4) % 1 : on ? (T / 3) % 1 : -1;
    g.save(); g.lineCap = "round"; g.lineJoin = "round";
    for (const [width, alpha] of [[10 * u, on ? .10 : .05], [4 * u, on ? .22 : .08]]) {
      g.strokeStyle = rgba(COLOR.accent, alpha); g.lineWidth = width; g.beginPath(); let open = false;
      for (const q of arc) { if (q.t > charge || !q.vis) { open = false; continue; } if (!open) { g.moveTo(q.x, q.y); open = true; } else g.lineTo(q.x, q.y); }
      g.stroke();
    }
    g.restore();
    const size = Math.max(2, 2.7 * u);
    for (const p of dots) {
      if (!p.vis) continue;
      const fade = origin ? 1 : clamp(p.t / .35, 0, 1);
      let a: number;
      if (on) { a = (p.t <= charge ? 1 : .3) * fade; const gap = head - p.t; if (gap >= 0 && gap < .14) a = Math.max(a, 1 - gap / .14 * .2); }
      else { a = .3 * fade; const gap = (head - p.t + 1) % 1; if (head >= 0 && gap < .28) a = Math.max(a, (1 - gap / .28) * fade); if (still) a = Math.max(a, p.t < .55 ? .9 * fade : .22); }
      g.fillStyle = a > .95 ? rgba(COLOR.light, a) : rgba(COLOR.accent, a);
      g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
    }
    if (!still) {
      const at = (k: number) => arc[Math.round(clamp(k, 0, 1) * 96)];
      const comet = busy ? at(head) : on && T < .7 ? at(T / .7) : on ? at(head) : null;
      if (comet?.vis) halo(comet.x, comet.y, (busy ? 13 : on && T < .7 ? 16 : 10) * u, COLOR.light, busy ? .7 : on && T < .7 ? .9 : .55);
    }
  }

  // You: a light pin with a ripple while idle; a small white square with a thin ring once the route is on.
  // Below 150 px (the phone layout) the names would crowd the globe: dots only.
  const fs = Math.max(11 * dpr, 11.5 * u), named = box.width >= 150;
  if (origin) {
    const p = screen(project(origin.lat, origin.lon, 0, v));
    if (p.vis) {
      if (!on && !busy) {
        if (!still) for (let i = 0; i < 2; i++) { const k = ((clock / 3) + i * .5) % 1; g.strokeStyle = rgba(COLOR.light, (1 - k) * .65); g.lineWidth = Math.max(1, u); g.beginPath(); g.arc(p.x, p.y, (5 + 24 * k) * u, 0, Math.PI * 2); g.stroke(); }
        halo(p.x, p.y, 14 * u, COLOR.light, .5);
        const size = Math.max(4, 5 * u); g.fillStyle = rgba(COLOR.light, 1); g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
        if (origin.label && named) label(g, origin.label, p.x, p.y + 16 * u + fs * .5, "center", COLOR.light, .9, fs, W, H, dpr);
      } else {
        const size = Math.max(3.5, 4.2 * u);
        g.strokeStyle = rgba(COLOR.text, .35); g.lineWidth = Math.max(1, u); g.beginPath(); g.arc(p.x, p.y, 7 * u, 0, Math.PI * 2); g.stroke();
        g.fillStyle = rgba(COLOR.text, .9); g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      }
    }
  }

  // The exit: amber while connecting; once landed, a light square in an amber halo, two rings going out once.
  if ((on || busy) && exit && B?.vis) {
    if (on) {
      const flare = still || T < .6 ? 0 : 1 - clamp((T - .6) / .8, 0, 1);
      halo(B.x, B.y, (22 + 16 * flare) * u, COLOR.accent, .4 + (still ? 0 : .15 * breath) + .45 * flare);
      if (!still && T > .6 && T < 2.1) for (let i = 0; i < 2; i++) {
        const k = clamp((T - .6 - i * .25) / 1.2, 0, 1);
        if (k <= 0 || k >= 1) continue;
        g.strokeStyle = rgba(COLOR.accent, (1 - k) * .85); g.lineWidth = Math.max(1, 1.6 * u * (1 - k) + .6);
        g.beginPath(); g.arc(B.x, B.y, (6 + 64 * ease(k)) * u, 0, Math.PI * 2); g.stroke();
      }
      const size = Math.max(6, 7 * u); g.fillStyle = rgba(COLOR.light, 1); g.fillRect(B.x - size / 2, B.y - size / 2, size, size);
    } else {
      const blink = still ? .8 : .45 + .55 * Math.abs(Math.sin(clock * Math.PI)), size = Math.max(4, 4.5 * u);
      g.fillStyle = rgba(COLOR.accent, blink); g.fillRect(B.x - size / 2, B.y - size / 2, size, size);
    }
    const A = origin ? screen(project(origin.lat, origin.lon, 0, v)) : null, left = A ? B.x < A.x : false;
    if (named) label(g, exit.label, B.x + (left ? -14 : 14) * u, B.y - fs * .9, left ? "right" : "left", on ? COLOR.accent : COLOR.text, on ? 1 : .8, fs, W, H, dpr);
  }
}

/** One label with a dark halo so it reads over the dots, kept inside the canvas. */
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, align: "left" | "right" | "center", color: readonly number[], alpha: number, fs: number, W: number, H: number, dpr: number) {
  const family = getComputedStyle(g.canvas).fontFamily || "sans-serif";
  g.font = `500 ${fs * 1.04}px ${family}`; g.textBaseline = "middle";
  g.shadowColor = "rgba(8,7,6,.95)"; g.shadowBlur = 5 * dpr;
  const width = g.measureText(text).width;
  const left = clamp(align === "center" ? x - width / 2 : align === "right" ? x - width : x, 4 * dpr, Math.max(4 * dpr, W - width - 4 * dpr));
  g.fillStyle = rgba(color, alpha); g.fillText(text, left, clamp(y, fs, H - fs));
  g.shadowBlur = 0;
}
