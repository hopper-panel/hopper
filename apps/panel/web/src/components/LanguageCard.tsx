import { LOCALES, LOCALE_NAMES, useTranslation } from '../i18n';
import { cx } from '../lib/cx';
import { Card } from './ui';

/**
 * Language picker.
 *
 * The choice lives in this browser, not on the account: the same person may
 * read the panel in one language at work and another at home, and it must apply
 * before anyone is signed in — the sign-in page is translated too.
 */
export function LanguageCard() {
  const { locale, chosen, instanceLocale, setLocale, t } = useTranslation();

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
        {t('account.languageTitle')}
      </h2>
      <p className="mb-4 text-sm text-content-muted">{t('account.languageHint')}</p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setLocale(null)}
          className={cx(
            'rounded-lg border px-3 py-2 text-sm transition-colors',
            chosen === null
              ? 'border-accent bg-accent/10 text-content'
              : 'border-border-subtle text-content-muted hover:text-content',
          )}
        >
          {t('account.languageAuto', { name: LOCALE_NAMES[instanceLocale] })}
        </button>

        {LOCALES.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setLocale(entry)}
            lang={entry}
            className={cx(
              'rounded-lg border px-3 py-2 text-sm transition-colors',
              chosen === entry
                ? 'border-accent bg-accent/10 text-content'
                : 'border-border-subtle text-content-muted hover:text-content',
            )}
          >
            {LOCALE_NAMES[entry]}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs text-content-subtle" lang={locale}>
        {LOCALE_NAMES[locale]}
      </p>
    </Card>
  );
}
