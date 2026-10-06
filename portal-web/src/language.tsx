import type { ReactNode } from "react";
import { ProductLanguage } from "../../shared/language";
import { languageStorageKey } from "../../shared/i18n-core";

export function PortalLanguage({ children }: { children: ReactNode }) {
  return <ProductLanguage storageKey={languageStorageKey} className="portal-language">{children}</ProductLanguage>;
}
