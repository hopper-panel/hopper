import { cx } from '../lib/cx';

/**
 * Two-state switch.
 *
 * A real `<input type="checkbox">` under the appearance of a switch, not a
 * `<div>` with an `onClick`: the box stays reachable by keyboard, announceable
 * by a screen reader and tied to its label without any of that having to be
 * reimplemented.
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
          // The focus ring has to follow the appearance, not the hidden box.
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
