import { cx } from '../lib/cx';

/**
 * Interrupteur à deux états.
 *
 * Un vrai `<input type="checkbox">` sous une apparence d'interrupteur, et non
 * un `<div>` avec un `onClick` : la case reste atteignable au clavier,
 * annonçable par un lecteur d'écran et associée à son libellé sans qu'on ait
 * à réimplémenter tout cela.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-lg border border-border-subtle bg-surface p-4',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />

      <span
        aria-hidden
        className={cx(
          'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors',
          checked ? 'bg-accent' : 'bg-surface-hover',
          // Le contour de focus doit suivre l'apparence, pas la case cachée.
          'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
        )}
      >
        <span
          className={cx(
            'h-4 w-4 rounded-full bg-surface-raised transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>

      <span className="min-w-0">
        <span className="block text-sm font-medium text-content">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-content-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
