/** Display name shown on every web surface; technical identifiers (env, package IDs, cookies) keep the Veilbird name. */
export const PRODUCT_NAME = "TrackNothing";

/** TrackNothing mark: an empty set (∅), a struck-through zero for "nothing". Colors follow `currentColor`, so each surface tints it. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <svg className="brand-logo" width={size} height={size} viewBox="9 9 46 46" fill="none" aria-hidden="true" focusable="false">
    <circle cx="32" cy="32" r="17" stroke="currentColor" strokeWidth="5.5" />
    <path d="M47 13L17 51" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
  </svg>;
}

/** Uppercase wordmark; the second word takes the accent color. */
export function BrandWordmark() {
  return <>TRACK<em>NOTHING</em></>;
}
