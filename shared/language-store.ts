import { createTranslator, intlLocales, isPreference, resolveLocale, type LanguagePreference } from "./i18n-core";

/** One external store per browser surface. No DOM rewriting and no translated business values. */
export function createLanguageStore(storageKey: string) {
  const read = (): LanguagePreference => { try { const value = localStorage.getItem(storageKey); return isPreference(value) ? value : "system"; } catch { return "system"; } };
  const languages = () => typeof navigator === "undefined" ? ["en"] : navigator.languages?.length ? navigator.languages : [navigator.language];
  let preference = read();
  let locale = resolveLocale(preference, languages());
  const listeners = new Set<() => void>();
  function refresh() { locale = resolveLocale(preference, languages()); for (const listener of listeners) listener(); }
  const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) { preference = read(); refresh(); } };
  return {
    locale: () => locale,
    preference: () => preference,
    snapshot: () => `${preference}:${locale}`,
    subscribe(listener: () => void) {
      if (!listeners.size && typeof window !== "undefined") { window.addEventListener("languagechange", refresh); window.addEventListener("storage", onStorage); }
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size && typeof window !== "undefined") { window.removeEventListener("languagechange", refresh); window.removeEventListener("storage", onStorage); } };
    },
    select(value: LanguagePreference) { if (!isPreference(value)) return; preference = value; try { localStorage.setItem(storageKey, value); } catch { /* Retain in memory. */ } refresh(); },
    t: (source: string, values?: readonly unknown[]) => createTranslator(locale)(source, values),
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(intlLocales[locale], options).format(value),
  };
}
