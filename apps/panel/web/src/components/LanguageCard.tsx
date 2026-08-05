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
  const { locale, setLocale, t } = useTranslation();

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
        {t('account.languageTitle')}
      </h2>
      <p className="mb-4 text-sm text-content-muted">{t('account.languageHint')}</p>

      {/* Highlighting the *effective* language, not the stored choice: someone
          who has never picked one would otherwise see nothing selected while
          reading the panel in a perfectly definite language. There is no
          "instance default" button — it named the same language a second time
          and said nothing the highlight does not already say. */}
      <div className="flex flex-wrap gap-2">
        {LOCALES.map((entry) => (
          <button
            key={entry}
            type="button"
            onClick={() => setLocale(entry)}
            lang={entry}
            aria-current={locale === entry ? 'true' : undefined}
            className={cx(
              'rounded-lg border px-3 py-2 text-sm transition-colors',
              locale === entry
                ? 'border-accent bg-accent/10 text-content'
                : 'border-border-subtle text-content-muted hover:text-content',
            )}
          >
            {LOCALE_NAMES[entry]}
          </button>
        ))}
      </div>
    </Card>
  );
}
