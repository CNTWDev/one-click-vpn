import { useEffect, useState } from "react";
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
