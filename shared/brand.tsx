/** Veilbird mark: a bird lifting out from behind a veil. Colors follow `currentColor`, so each surface tints it. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <svg className="brand-logo" width={size} height={size} viewBox="6 10 52 40" fill="none" aria-hidden="true" focusable="false">
    <g transform="translate(1 3)" fill="currentColor">
      <path d="M25.5 36.5C24.5 27.5 20.5 19.5 14 13.5C24.5 15.5 33.5 21.5 39 29.5Z" opacity=".62" />
      <path d="M11 42.5C21 40.5 29.5 36 37.5 29C41 26 44.5 23.2 48.5 22.6L55 21.8L50 26.2C45.5 32 38.5 37.2 30.5 39.8C24 41.9 17.5 43.2 11 42.5Z" />
    </g>
    <path d="M8 40C18 46 34 49 56 44" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity=".5" />
  </svg>;
}
