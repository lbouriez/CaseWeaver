import { isSupportedLocale, type SupportedLocale } from "./languages";

/** Browser-only preference keys. They hold a locale choice, never identity or case data. */
export const languagePreferenceStorageKey = "caseweaver.docs.locale";
export const languageSuggestionDismissedStorageKey =
  "caseweaver.docs.locale-suggestion-dismissed";

export function supportedLocaleFromBrowserLanguages(
  languages: readonly string[],
): SupportedLocale | undefined {
  for (const language of languages) {
    const locale = language.toLowerCase().split("-")[0] ?? "";
    if (isSupportedLocale(locale)) return locale;
  }
  return undefined;
}

export function shouldSuggestLocale({
  currentLocale,
  browserLanguages,
  dismissed,
  storedLocale,
}: {
  readonly currentLocale: SupportedLocale;
  readonly browserLanguages: readonly string[];
  readonly dismissed: boolean;
  readonly storedLocale?: SupportedLocale;
}): SupportedLocale | undefined {
  if (dismissed || storedLocale !== undefined) return undefined;
  const suggested = supportedLocaleFromBrowserLanguages(browserLanguages);
  return suggested === currentLocale ? undefined : suggested;
}

function readStorage(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A privacy-restricted browser can still use the documentation website.
  }
}

export function storedLocalePreference(): SupportedLocale | undefined {
  const value = readStorage(languagePreferenceStorageKey);
  return value !== undefined && isSupportedLocale(value) ? value : undefined;
}

export function storeLocalePreference(locale: SupportedLocale): void {
  writeStorage(languagePreferenceStorageKey, locale);
}

export function languageSuggestionWasDismissed(): boolean {
  return readStorage(languageSuggestionDismissedStorageKey) === "true";
}

export function dismissLanguageSuggestion(): void {
  writeStorage(languageSuggestionDismissedStorageKey, "true");
}
