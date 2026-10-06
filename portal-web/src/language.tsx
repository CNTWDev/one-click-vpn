import type { ReactNode } from "react";
import { ProductLanguage, ProductLanguagePicker } from "../../shared/language";
import { languageStorageKey } from "../../shared/i18n-core";

export function PortalLanguage({ children }: { children: ReactNode }) {
  return <ProductLanguage storageKey={languageStorageKey}>{children}</ProductLanguage>;
}
/** Compact picker: sits in the dashboard header, or floats top-right on the sign-in and status pages. */
export function PortalLanguagePicker({ floating = false }: { floating?: boolean }) {
  return floating ? <div className="portal-language-floating"><ProductLanguagePicker className="portal-language" /></div> : <ProductLanguagePicker className="portal-language" />;
}
