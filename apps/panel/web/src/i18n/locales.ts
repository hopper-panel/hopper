/**
 * Interface languages.
 *
 * English is the source language: every key is written there first, and the
 * other catalogues are translations of it. A missing key falls back to English
 * rather than showing the key itself — a half-translated screen is usable, a
 * screen full of `server.console.title` is not.
 */
export const LOCALES = ['en', 'fr', 'es', 'de', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Names shown in the language picker, each in its own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  ru: 'Русский',
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Best match for a browser language list.
 *
 * `navigator.languages` holds tags such as `fr-CA` or `es-419`; only the
 * primary subtag is compared, since the catalogues are not region-specific.
 */
export function matchLocale(preferred: readonly string[]): Locale | null {
  for (const tag of preferred) {
    const primary = tag.split('-')[0]?.toLowerCase() ?? '';

    if (isLocale(primary)) {
      return primary;
    }
  }

  return null;
}
