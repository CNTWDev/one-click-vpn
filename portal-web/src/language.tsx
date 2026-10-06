import { useEffect, useState, type ReactNode } from "react";
import { I18nProvider, useI18n } from "../../shared/i18n";
import { isPreference, languageStorageKey, resolveLocale, intlLocales, type LanguagePreference } from "../../shared/i18n-core";

function readPreference(): LanguagePreference {
  try { const saved = localStorage.getItem(languageStorageKey); return isPreference(saved) ? saved : "system"; }
  catch { return "system"; }
}
function LanguagePicker({ preference, onChange }: { preference: LanguagePreference; onChange: (value: LanguagePreference) => void }) {
  const { t } = useI18n();
  return <div className="portal-language-bar"><label className="portal-language-picker"><span aria-hidden="true">◎</span><span className="language-caption">{t("语言")}</span>
    <select aria-label={t("语言")} value={preference} onChange={(event) => onChange(event.target.value as LanguagePreference)}>
      <option value="system">{t("跟随系统")}</option><option value="zh" lang="zh">简体中文</option><option value="en" lang="en">English</option><option value="ru" lang="ru">Русский</option>
    </select>
  </label></div>;
}
export function PortalLanguage({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LanguagePreference>(readPreference);
  const [languages, setLanguages] = useState<readonly string[]>(() => navigator.languages?.length ? navigator.languages : [navigator.language]);
  const locale = resolveLocale(preference, languages);
  useEffect(() => {
    const update = () => setLanguages(navigator.languages?.length ? navigator.languages : [navigator.language]);
    const storage = (event: StorageEvent) => { if (event.key === languageStorageKey || event.key === null) setPreference(readPreference()); };
    window.addEventListener("languagechange", update); window.addEventListener("storage", storage);
    return () => { window.removeEventListener("languagechange", update); window.removeEventListener("storage", storage); };
  }, []);
  useEffect(() => { document.documentElement.lang = intlLocales[locale]; }, [locale]);
  function change(value: LanguagePreference) {
    setPreference(value);
    try { localStorage.setItem(languageStorageKey, value); } catch { /* Switching still works when storage is disabled. */ }
  }
  return <I18nProvider locale={locale}><LanguagePicker preference={preference} onChange={change} />{children}</I18nProvider>;
}
