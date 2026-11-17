import { memo } from "react";

/**
 * The faint star field behind every Portal page (same as the apps): a pixel Milky Way crossing the flat ground on a
 * slant, a far star layer that drifts very slowly and a few cross glints. No nebula, planet or texture: the page stays
 * flat like the Console. Stars are seeded, so every visit draws the same sky; one SVG, no images. Reduced motion stops
 * the drift and twinkles.
 */
type Star = { x: number; y: number; size: number; tone: number; alpha: number };

const W = 1440, H = 900;
const TONES = ["#e8ecf4", "#bfcbe6", "#c6f26e"];

function random(seed: number) {
  let a = seed;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function field(count: number, seed: number): Star[] {
  const r = random(seed), out: Star[] = [];
  for (let i = 0; i < count; i++) {
    const k = r();
    out.push({ x: r() * W, y: Math.pow(r(), 1.25) * H, size: k < 0.72 ? 1 : 2, tone: r() < 0.12 ? 1 : 0, alpha: 0.14 + r() * 0.5 });
  }
  return out;
}

/** Stars gathered on a slanted band, denser along its middle (normal spread across it). */
function band(count: number, seed: number, degrees: number): Star[] {
  const r = random(seed), out: Star[] = [], a = degrees * Math.PI / 180, cx = W * 0.55, cy = H * 0.4;
  for (let i = 0; i < count; i++) {
    const along = (r() - 0.5) * 1.6 * W;
    const across = Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r()) * 86 * (1 - Math.abs(along) / W * 0.35);
    const x = cx + along * Math.cos(a) - across * Math.sin(a), y = cy + along * Math.sin(a) + across * Math.cos(a);
    if (x < 0 || x > W || y < 0 || y > H) continue;
    const k = r();
    out.push({ x, y, size: k < 0.8 ? 1 : 2, tone: k < 0.5 ? 1 : k < 0.85 ? 0 : 2, alpha: 0.12 + r() * 0.5 });
  }
  return out;
}

/** One path per tone and brightness step, so ~750 stars cost a dozen DOM nodes. */
function paths(stars: Star[]) {
  const groups = new Map<string, string>();
  for (const s of stars) {
    const key = `${s.tone}:${Math.round(s.alpha * 10) / 10}`;
    groups.set(key, (groups.get(key) || "") + `M${Math.round(s.x)} ${Math.round(s.y)}h${s.size}v${s.size}h-${s.size}z`);
  }
  return [...groups].map(([key, d]) => { const [tone, alpha] = key.split(":"); return { d, fill: TONES[Number(tone)], opacity: Number(alpha) }; });
}

const FAR = field(240, 3);
const TWINKLE = FAR.filter((_, index) => index % 7 === 0);
const STILL = paths([...band(520, 5, -13), ...FAR.filter((_, index) => index % 7 !== 0)]);
const GLINTS = [[86, 270, 0.8], [677, 117, 0.9], [1397, 468, 0.6], [490, 630, 0.5]];

export const SpaceBackdrop = memo(function SpaceBackdrop() {
  return <div className="space" aria-hidden="true">
    <svg className="space-stars" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" shapeRendering="crispEdges">
      <g className="space-far">
        {STILL.map((p, index) => <path key={index} d={p.d} fill={p.fill} opacity={p.opacity} />)}
        {TWINKLE.map((s, index) => <rect key={index} className="space-twinkle" x={Math.round(s.x)} y={Math.round(s.y)} width={s.size} height={s.size}
          fill={TONES[s.tone]} opacity={s.alpha} style={{ animationDelay: `${-(index * 731) % 7000}ms` }} />)}
      </g>
      {GLINTS.map(([x, y, alpha], index) => <path key={index} className="space-twinkle" d={`M${x} ${y - 3}h1v7h-1zM${x - 3} ${y}h7v1h-7zM${x - 1} ${y - 1}h3v3h-3z`}
        fill="#e6ecf8" opacity={alpha} style={{ animationDelay: `${-index * 2300}ms`, animationDuration: "9s" }} />)}
    </svg>
  </div>;
});
