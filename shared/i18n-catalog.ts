import consoleCatalog from "./i18n-console.json";
import { sharedCatalog } from "./i18n-shared";

/** Every translation (Console and Portal), for tests and tools. The apps load only what they show. */
export const catalog: Record<string, readonly [en: string, ru: string]> = {
  ...Object.fromEntries(Object.entries(consoleCatalog).map(([key, [en, ru]]) => [key, [en, ru] as const])),
  ...sharedCatalog,
};
