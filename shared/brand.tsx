import { PRODUCT_NAME } from "./brand-name";
import { logoDataUrl } from "./site";

export { PRODUCT_NAME } from "./brand-name";

/** The ∅ mark on a 16×16 grid; same cells as scripts/brand-icons.py and the native clients. */
export const MARK_CELLS: readonly (readonly [number, number])[] = ("14,1 5,2 6,2 7,2 8,2 9,2 10,2 13,2 3,3 4,3 11,3 12,3 2,4 11,4 13,4 2,5 10,5 13,5 1,6 9,6 14,6 1,7 8,7 14,7 "
  + "1,8 7,8 14,8 1,9 6,9 14,9 2,10 5,10 13,10 2,11 4,11 13,11 3,12 4,12 11,12 12,12 2,13 5,13 6,13 7,13 8,13 9,13 10,13 1,14")
  .split(" ").map((cell) => cell.split(",").map(Number) as [number, number]);
/** Squares of `size` (in cells) at each cell, as one SVG path. */
export const cellsPath = (cells: readonly (readonly [number, number])[], size = 0.86) => cells.map(([x, y]) => `M${x},${y}h${size}v${size}h-${size}z`).join("");
const MARK_PATH = cellsPath(MARK_CELLS);

/**
 * TrackNothing mark: an empty set (∅) drawn in square pixels. Colors follow `currentColor`, so each surface tints it.
 * A site with its own logo shows that SVG instead, through <img> so nothing inside it can run.
 */
export function BrandMark({ size = 24, logoSvg = "" }: { size?: number; logoSvg?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- Vite apps; a data: URL built from the site's own SVG
  if (logoSvg) return <img className="brand-logo" src={logoDataUrl(logoSvg)} width={size} height={size} alt="" />;
  return <svg className="brand-logo" width={size} height={size} viewBox="0.5 0.5 15 15" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <path d={MARK_PATH} fill="currentColor" />
  </svg>;
}

/** Uppercase wordmark; in a two-word CamelCase name ("TrackNothing") the second word takes the accent color. */
export function BrandWordmark({ name = PRODUCT_NAME }: { name?: string }) {
  const words = /^([A-Z][a-z0-9]+)([A-Z][A-Za-z0-9]*)$/.exec(name);
  return words ? <>{words[1].toUpperCase()}<em>{words[2].toUpperCase()}</em></> : <>{name.toUpperCase()}</>;
}
