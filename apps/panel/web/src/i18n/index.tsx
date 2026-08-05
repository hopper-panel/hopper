import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { DEFAULT_LOCALE, isLocale, matchLocale, type Locale } from './locales';
import { de } from './messages/de';
import { en, type MessageKey, type Messages } from './messages/en';
import { es } from './messages/es';
import { fr } from './messages/fr';
import { ru } from './messages/ru';

/**
 * Catalogues, English first.
 *
 * Translations are `Partial`: a key added to English may be missing from them,
 * and the lookup falls back to English rather than to the key itself. A screen
 * that is half translated stays usable; one full of `console.uptime` does not.
 */
const CATALOGUES: Record<Locale, Partial<Messages>> = { en, fr, es, de, ru };

const STORAGE_KEY = 'hopper.locale';

interface Translation {
  /** Active language, whether chosen or inherited. */
  locale: Locale;
  /** Language chosen in this browser, or null when following the instance. */
  chosen: Locale | null;
  /** Language the instance serves to visitors who have not chosen one. */
  instanceLocale: Locale;
  setLocale: (locale: Locale | null) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const TranslationContext = createContext<Translation | null>(null);

/**
 * Interface language.
 *
 * Resolution order: the choice stored in this browser, then the instance
 * default, then the browser's own languages, then English. The instance default
 * comes from a public endpoint so that the sign-in page — seen before anyone is
 * authenticated — is already in the right language.
 */
export function TranslationProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<Locale | null>(readStoredLocale);
  const [instanceLocale, setInstanceLocale] = useState<Locale>(
    () => matchLocale(navigator.languages ?? [navigator.language]) ?? DEFAULT_LOCALE,
  );

  useEffect(() => {
    let active = true;

    void api
      .get<{ defaultLocale: string }>('/api/panel')
      .then((branding) => {
        if (active && isLocale(branding.defaultLocale)) {
          setInstanceLocale(branding.defaultLocale);
        }
      })
      .catch(() => {
        // Panel unreachable: the browser language already picked earlier stands.
        // A missing translation must never keep the page from rendering.
      });

    return () => {
      active = false;
    };
  }, []);

  const locale = chosen ?? instanceLocale;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale | null) => {
    setChosen(next);

    try {
      if (next === null) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Private browsing denies storage. The choice still applies to this page.
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>): string => {
      // English is the fallback, not the key: a half-translated screen stays
      // usable, one full of `console.uptime` does not.
      const template = CATALOGUES[locale][key] ?? en[key];

      return values === undefined ? template : interpolate(template, values);
    },
    [locale],
  );

  const value = useMemo<Translation>(
    () => ({ locale, chosen, instanceLocale, setLocale, t }),
    [locale, chosen, instanceLocale, setLocale, t],
  );

  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): Translation {
  const context = useContext(TranslationContext);

  if (!context) {
    throw new Error('useTranslation used outside TranslationProvider.');
  }

  return context;
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export { LOCALES, LOCALE_NAMES, type Locale } from './locales';
export type { MessageKey };
