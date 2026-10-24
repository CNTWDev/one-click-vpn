import { PRODUCT_NAME } from "./brand-name";
import { logoDataUrl } from "./site";

export { PRODUCT_NAME } from "./brand-name";

/**
 * TrackNothing mark: an empty set (∅), a struck-through zero for "nothing". Colors follow `currentColor`, so each surface tints it.
 * A site with its own logo shows that SVG instead, through <img> so nothing inside it can run.
 */
export function BrandMark({ size = 24, logoSvg = "" }: { size?: number; logoSvg?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- Vite apps; a data: URL built from the site's own SVG
  if (logoSvg) return <img className="brand-logo" src={logoDataUrl(logoSvg)} width={size} height={size} alt="" />;
  return <svg className="brand-logo" width={size} height={size} viewBox="9 9 46 46" fill="none" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="17" stroke="currentColor" strokeWidth="5.5" />
    <path d="M47 13L17 51" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
  </svg>;
}

/** Uppercase wordmark; in a two-word CamelCase name ("TrackNothing") the second word takes the accent color. */
export function BrandWordmark({ name = PRODUCT_NAME }: { name?: string }) {
  const words = /^([A-Z][a-z0-9]+)([A-Z][A-Za-z0-9]*)$/.exec(name);
  return words ? <>{words[1].toUpperCase()}<em>{words[2].toUpperCase()}</em></> : <>{name.toUpperCase()}</>;
}
