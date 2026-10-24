import { useEffect, useState } from "react";
import { MARK_CELLS, cellsPath } from "../../shared/brand";

/** Cells one cell wide on a circle of `radius` in an n×n grid: the clients' connect ring (136 dots at 41/18). */
function ringCells(n: number, radius: number) {
  const c = (n - 1) / 2, cells: [number, number][] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (Math.abs(Math.hypot(x - c, y - c) - radius) <= 0.55) cells.push([x, y]);
  return cells;
}
// The mark sits in the middle of the ring at 80/246 of its width, as in the apps.
const MARK_SCALE = 41 * 80 / 246 / 16;
const MARK_PATH = cellsPath(MARK_CELLS);

const RING_CELLS = ringCells(41, 18);
/**
 * The hero's large ring, as in the apps once connected: every dot lit over a halftone halo, the ∅ mark inside, and
 * every thirteenth dot dimming briefly on its own six-second beat (still under reduced motion).
 */
export function HeroRing() {
  return <span className="hero-ring" aria-hidden="true">
    <svg viewBox="0 0 41 41" shapeRendering="crispEdges">
      {RING_CELLS.map(([x, y], index) => <rect key={index} x={x} y={y} width={0.75} height={0.75}
        className={index % 13 === 0 ? "twinkle" : undefined} style={index % 13 === 0 ? { animationDelay: `${-((x * 37 + y * 11) % 6000)}ms` } : undefined} />)}
      <path d={MARK_PATH} transform={`translate(${20.5 - 8 * MARK_SCALE} ${20.5 - 8 * MARK_SCALE}) scale(${MARK_SCALE})`} />
    </svg>
  </span>;
}

const HEX = "0123456789ABCDEF";
/** Each digit changes on its own slow beat (3–9 s), so about three change every second; same as the apps. */
function digits(seconds: number, count = 16, salt = 0) {
  let line = "";
  for (let i = 0; i < count; i++) {
    const beat = Math.floor(seconds / (3 + i % 7));
    let h = Math.imul(beat ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1 + salt * 97, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 13;
    line += HEX[(h >>> 0) % 16] + (i % 4 === 3 && i < count - 1 ? " " : "");
  }
  return line;
}
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The "data stream" line: hex digits that slowly change, held still under reduced motion and in hidden tabs. */
export function DataStream({ count = 16, salt = 0, className = "" }: { count?: number; salt?: number; className?: string }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Math.floor(Date.now() / 1000)); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={`pixel-stream ${className}`.trim()} aria-hidden="true">{digits(now, count, salt)}</span>;
}

/** 30 days of usage as columns of square blocks, the last seven days lit. */
export function UsageBlocks({ values }: { values: number[] }) {
  if (!values.length) return null;
  const rows = 5, top = Math.max(...values, 1), pitch = 6, block = 4, gap = 2, width = 4;
  const lit = values.map((value) => value <= 0 ? 1 : Math.max(1, Math.round(rows * value / top)));
  return <svg className="pixel-blocks" viewBox={`0 0 ${values.length * (width + gap) - gap} ${(rows - 1) * pitch + block}`} preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
    {lit.map((count, i) => <path key={i} className={i >= values.length - 7 ? "recent" : undefined}
      d={Array.from({ length: count }, (_, r) => `M${i * (width + gap)},${(rows - 1 - r) * pitch}h${width}v${block}h-${width}z`).join("")} />)}
  </svg>;
}
