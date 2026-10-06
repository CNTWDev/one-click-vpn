import type { ReactNode } from "react";
import { createLanguageStore } from "../../shared/language-store";
import { LanguagePicker, LanguageScope, useProductLanguage } from "../../shared/language";
import { errorText } from "../../shared/i18n-errors";

export const consoleLanguage = createLanguageStore("veilbird.console.language");
export const t = consoleLanguage.t;
export const localError = (value: string) => errorText(value, t);
export const useConsoleLanguage = () => useProductLanguage(consoleLanguage);
export function ConsoleLanguage({ children }: { children: ReactNode }) { return <LanguageScope store={consoleLanguage}>{children}</LanguageScope>; }
export function ConsoleLanguagePicker() { return <LanguagePicker store={consoleLanguage} className="console-language" />; }
