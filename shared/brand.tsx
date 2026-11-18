import { PRODUCT_NAME } from "./brand-name";
import { logoDataUrl } from "./site";

export { PRODUCT_NAME } from "./brand-name";

/**
 * The ∅ mark in a 100×100 box, solid form: a heavy ring and bar with a gap where the bar crosses (scripts/brand-icons.py
 * draws the same shape; the app icons fill it with dots at large sizes).
 */
export const MARK_PATH = "M84.06,34.32A37.5,37.5 0 0,1 34.32,84.06L46.21,72.18A22.5,22.5 0 0,0 72.18,46.21ZM15.94,65.68A37.5,37.5 0 0,1 65.68,15.94L53.79,27.82A22.5,22.5 0 0,0 27.82,53.79ZM11.82,78.28L78.28,11.82L88.18,21.72L21.72,88.18Z";

/**
 * TrackNothing mark: an empty set (∅) as a heavy ring and bar. Colors follow `currentColor`, so each surface tints it.
 * A site with its own logo shows that SVG instead, through <img> so nothing inside it can run.
 */
export function BrandMark({ size = 24, logoSvg = "" }: { size?: number; logoSvg?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- Vite apps; a data: URL built from the site's own SVG
  if (logoSvg) return <img className="brand-logo" src={logoDataUrl(logoSvg)} width={size} height={size} alt="" />;
  return <svg className="brand-logo" width={size} height={size} viewBox="8 8 84 84" aria-hidden="true" focusable="false">
    <path d={MARK_PATH} fill="currentColor" />
  </svg>;
}

/** Uppercase wordmark; in a two-word CamelCase name ("TrackNothing") the second word takes the accent color. */
export function BrandWordmark({ name = PRODUCT_NAME }: { name?: string }) {
  const words = /^([A-Z][a-z0-9]+)([A-Z][A-Za-z0-9]*)$/.exec(name);
  return words ? <>{words[1].toUpperCase()}<em>{words[2].toUpperCase()}</em></> : <>{name.toUpperCase()}</>;
}
