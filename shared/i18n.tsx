import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, type Locale } from "./i18n-core";

// English is the default everywhere; both apps wrap their tree in the language the visitor picked.
const I18nContext = createContext({ locale: "en" as Locale, t: createTranslator("en") });
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export const useI18n = () => useContext(I18nContext);
