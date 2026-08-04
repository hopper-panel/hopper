import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface MenuAction {
  label: string;
  /** Pictogramme, à gauche du libellé. Une simple chaîne suffit. */
  icon?: ReactNode;
  onSelect: () => void;
  /** Rouge et détaché du reste : pour ce qui détruit. */
  destructive?: boolean;
  /** Absent de la liste plutôt que grisé, comme partout ailleurs. */
  hidden?: boolean;
}

/**
 * Menu contextuel d'une ligne, ouvert par trois points.
 *
 * Écrit à la main plutôt qu'emprunté à une bibliothèque de composants : c'est
 * une centaine de lignes, contre une dépendance qui apporterait son propre
 * système de portails et de thèmes pour ce seul usage.
 *
 * Le menu se ferme au clic à l'extérieur et à la touche Échap — sans quoi il
 * resterait ouvert derrière la boîte de dialogue qu'il vient de déclencher.
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

    // `mousedown` et non `click` : un clic sur un autre bouton déclencherait
    // sinon son action avant que ce menu n'ait disparu.
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
          // Aligné à droite et remontant si nécessaire : sur les dernières
          // lignes d'une longue liste, un menu qui descend sort de l'écran.
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
