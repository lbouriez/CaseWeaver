export const supportedLocales = ["en", "fr"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

export const languageNames: Readonly<Record<SupportedLocale, string>> = {
  en: "English",
  fr: "Français",
};

export function isSupportedLocale(value: string): value is SupportedLocale {
  return supportedLocales.includes(value as SupportedLocale);
}
