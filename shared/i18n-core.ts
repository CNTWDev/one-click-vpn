import { catalog } from "./i18n-catalog";

export type Locale = "zh" | "en" | "ru";
export type LanguagePreference = Locale | "system";
export const languageStorageKey = "veilbird.portal.language";
export const intlLocales: Record<Locale, string> = { zh: "zh-CN", en: "en-US", ru: "ru-RU" };
export const isPreference = (value: unknown): value is LanguagePreference => ["system", "zh", "en", "ru"].includes(String(value));
export function resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh" || base === "en" || base === "ru") return base;
  }
  return "en";
}
export type Translator = (source: string, values?: readonly unknown[]) => string;
export type LocalizedMessage = string | { source: string; values: readonly unknown[] };
export const message = (source: string, values: readonly unknown[] = []): LocalizedMessage => ({ source, values });
export const translateMessage = (value: LocalizedMessage, t: Translator): string => typeof value === "string" ? t(value) : t(value.source, value.values);
export function createTranslator(locale: Locale): Translator {
  return (source, values = []) => {
    const template = locale === "zh" ? source : catalog[source]?.[locale === "en" ? 0 : 1] ?? source;
    return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? "") : match);
  };
}
export function formatDate(value: string | null | undefined, locale: Locale): string {
  const t = createTranslator(locale);
  if (!value) return t("尚无记录");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? t("时间未知") : new Intl.DateTimeFormat(intlLocales[locale], {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}
export function formatActivity(value: string | null | undefined, locale: Locale, now = Date.now()): string {
  const t = createTranslator(locale);
  if (!value) return t("尚未使用");
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return t("时间未知");
  if (elapsed < 60_000) return t("刚刚活跃");
  const [divisor, unit] = elapsed < 3_600_000 ? [60_000, "minute"] as const : elapsed < 86_400_000 ? [3_600_000, "hour"] as const : [86_400_000, "day"] as const;
  return new Intl.RelativeTimeFormat(intlLocales[locale], { numeric: "always" }).format(-Math.floor(elapsed / divisor), unit);
}
