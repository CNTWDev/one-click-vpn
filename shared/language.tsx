import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  return store ? <LanguageMenu store={store} className={className} /> : null;
}

/** Languages in their own names; flags are deliberately absent because a flag names a country, not a language. */
const languageNames = [["en", "English"], ["zh", "简体中文"], ["ru", "Русский"]] as const;
/** Globe button that opens a short language list, with "System" on top. */
export function LanguageMenu({ store, className }: { store: LanguageStore; className: string }) {
  const locale = useProductLanguage(store);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const preference = store.preference();
  useEffect(() => {
    if (!open) return;
    const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") || [])];
    (items().find((item) => item.getAttribute("aria-checked") === "true") || items()[0])?.focus();
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const list = items(), index = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const choose = (value: LanguagePreference) => { store.select(value); setOpen(false); };
  const option = (value: LanguagePreference, label: string, lang?: string) => <button key={value} type="button" role="menuitemradio" aria-checked={preference === value} lang={lang} onClick={() => choose(value)}>{label}</button>;
  return <div className={`${className}-menu`} ref={root}>
    <button type="button" className={`${className}-trigger`} aria-haspopup="menu" aria-expanded={open} aria-label={store.t("语言")} title={store.t("语言")} onClick={() => setOpen(!open)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>
      <span lang={locale}>{languageNames.find(([value]) => value === locale)?.[1]}</span>
    </button>
    {open && <div className={`${className}-list`} role="menu" aria-label={store.t("语言")}>
      {option("system", store.t("跟随系统"))}
      <hr />
      {languageNames.map(([value, label]) => option(value, label, value))}
    </div>}
  </div>;
}
