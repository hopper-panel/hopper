import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface MenuAction {
  label: string;
  /** Glyph, to the left of the label. A plain string is enough. */
  icon?: ReactNode;
  onSelect: () => void;
  /** Red and set apart from the rest: for what destroys. */
  destructive?: boolean;
  /** Absent from the list rather than greyed out, as everywhere else. */
  hidden?: boolean;
}

/**
 * Context menu for a row, opened by three dots.
 *
 * Hand-written rather than borrowed from a component library: it is a hundred
 * lines, against a dependency that would bring its own portal and theming
 * system for this one use.
 *
 * The menu closes on a click outside and on Escape — without which it would
 * stay open behind the dialog it just triggered.
 */
export function KebabMenu({ actions, label }: { actions: MenuAction[]; label: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    // `mousedown` and not `click`: a click on another button would otherwise
    // fire its action before this menu had gone.
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const visible = actions.filter((action) => !action.hidden);

  if (visible.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={cx(
          'rounded px-2 py-1 text-content-muted transition-colors hover:bg-surface-hover hover:text-content',
          open && 'bg-surface-hover text-content',
        )}
      >
        <span aria-hidden>•••</span>
      </button>

      {open ? (
        <div
          role="menu"
          // Right-aligned and rising if need be: on the last rows of a long
          // list, a menu that drops down runs off the screen.
          className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-lg border border-border-subtle bg-surface-raised py-1 shadow-lg"
        >
          {visible.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                action.destructive
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-content-muted hover:bg-surface-hover hover:text-content',
              )}
            >
              <span aria-hidden className="w-4 text-center text-xs">
                {action.icon}
              </span>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
