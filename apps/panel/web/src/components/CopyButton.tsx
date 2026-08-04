import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { copyText } from '../lib/clipboard';
import { cx } from '../lib/cx';

/**
 * Copy button, with visual feedback.
 *
 * The feedback is not decorative: nothing distinguishes a filled clipboard from
 * a click with no effect. And since copying can genuinely fail — a panel served
 * over plain HTTP has no access to the clipboard API — the failure is said
 * rather than passed off as a silent success.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') {
      return;
    }

    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={cx(
        'text-xs transition-colors',
        state === 'failed' ? 'text-danger' : 'text-accent hover:underline',
        className,
      )}
      onClick={() => {
        void copyText(value).then((copied) => setState(copied ? 'copied' : 'failed'));
      }}
    >
      {state === 'copied'
        ? t('common.copied')
        : state === 'failed'
          ? t('common.failed')
          : (label ?? t('common.copy'))}
    </button>
  );
}
