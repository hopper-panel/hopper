import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { cx } from '../lib/cx';

/**
 * Bouton de copie, avec retour visuel.
 *
 * Le retour n'est pas décoratif : rien ne distingue un presse-papiers rempli
 * d'un clic sans effet. Et comme la copie peut réellement échouer — le panel
 * servi en HTTP n'a pas accès à l'API du presse-papiers — l'échec est dit,
 * plutôt que confondu avec un succès silencieux.
 */
export function CopyButton({
  value,
  label = 'copier',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
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
      {state === 'copied' ? 'copié' : state === 'failed' ? 'échec' : label}
    </button>
  );
}
