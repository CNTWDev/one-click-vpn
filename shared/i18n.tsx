import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, type Locale } from "./i18n-core";

// Shared admin components retain Chinese unless explicitly wrapped by the Portal.
const I18nContext = createContext({ locale: "zh" as Locale, t: createTranslator("zh") });
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export const useI18n = () => useContext(I18nContext);
