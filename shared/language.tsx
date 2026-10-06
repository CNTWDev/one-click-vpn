import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { I18nProvider } from "./i18n";
import { intlLocales, type LanguagePreference } from "./i18n-core";
import { createLanguageStore } from "./language-store";

export type LanguageStore = ReturnType<typeof createLanguageStore>;
export function useProductLanguage(store: LanguageStore) {
  useSyncExternalStore(store.subscribe, store.snapshot, () => "system:en");
  return store.locale();
}
export function LanguageScope({ children, store }: { children: ReactNode; store: LanguageStore }) {
  const locale = useProductLanguage(store);
  useEffect(() => { document.documentElement.lang = intlLocales[locale]; document.documentElement.dir = "ltr"; }, [locale]);
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
export function LanguagePicker({ store, className }: { store: LanguageStore; className: string }) {
  useProductLanguage(store);
  return <div className={`${className}-bar`}><label className={`${className}-picker`}><span className="language-caption">{store.t("语言")}</span>
    <select aria-label={store.t("语言")} value={store.preference()} onChange={event => store.select(event.target.value as LanguagePreference)}>
      <option value="system">{store.t("跟随系统")}</option><option value="zh" lang="zh">简体中文</option><option value="en" lang="en">English</option><option value="ru" lang="ru">Русский</option>
    </select>
  </label></div>;
}
const LanguageStoreContext = createContext<LanguageStore | null>(null);
/** Provides the language and lets each page place its own picker (e.g. inside the header) with ProductLanguagePicker. */
export function ProductLanguage({ children, storageKey }: { children: ReactNode; storageKey: string }) {
  const [store] = useState(() => createLanguageStore(storageKey));
  return <LanguageStoreContext.Provider value={store}><LanguageScope store={store}>{children}</LanguageScope></LanguageStoreContext.Provider>;
}
export function ProductLanguagePicker({ className }: { className: string }) {
  const store = useContext(LanguageStoreContext);
  return store ? <LanguagePicker store={store} className={className} /> : null;
}
