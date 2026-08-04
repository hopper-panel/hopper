import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * Boîte de dialogue modale.
 *
 * Écrite à la main plutôt qu'avec `<dialog>` natif : celui-ci impose son propre
 * fond, son propre centrage et une pile d'affichage au-dessus de tout le
 * document, qu'il faut ensuite défaire pour l'accorder au thème. Une centaine
 * de lignes ici donnent le même comportement sans lutter contre le navigateur.
 *
 * Trois choses qu'on oublie facilement et qui rendent une modale pénible :
 * Échap doit fermer, le clic sur le fond aussi, et le défilement de la page en
 * arrière-plan doit être suspendu — sinon la molette fait glisser le document
 * sous la boîte, qui semble alors flotter dans le vide.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Actions, alignées à droite en bas de la boîte. */
  footer?: ReactNode;
  /** `lg` pour un contenu dense — une liste de permissions commentées. */
  size?: 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * `onClose` passe par une ref plutôt que par les dépendances de l'effet.
   *
   * L'appelant l'écrit presque toujours en ligne — `onClose={() => setOpen(false)}` —
   * donc une fonction neuve à chaque rendu. Placée en dépendance, elle faisait
   * rejouer l'effet à *chaque* rendu du parent : le focus repartait alors sur
   * le premier champ de la boîte et le défilement du corps était rétabli puis
   * resuspendu. Concrètement, cliquer dans une zone de texte pendant que la
   * page se rafraîchissait en arrière-plan renvoyait le curseur ailleurs.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };

    // Le focus entre dans la boîte : sans cela il resterait sur le bouton qui
    // l'a ouverte, et la tabulation parcourrait la page derrière.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
    // Volontairement limité à `open` : l'effet met en place et défait
    // l'ouverture, il ne doit pas rejouer sur un simple rendu.
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      // Fond assombri, sans `backdrop-blur` : flouter tout l'arrière-plan
      // oblige le compositeur à le recalculer à chaque image, sur toute la
      // surface de la fenêtre. Le coût est invisible sur une page figée et
      // très net dès que quelque chose s'anime derrière.
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16"
      // Le clic ne ferme que s'il naît **et** se termine sur le fond : une
      // sélection de texte commencée dans un champ et relâchée à l'extérieur
      // refermerait sinon la boîte en perdant la saisie.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'w-full rounded-xl border border-border-subtle bg-surface-raised shadow-2xl',
          size === 'lg' ? 'max-w-4xl' : 'max-w-2xl',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-4">
          <h2 className="text-lg font-semibold text-content">{title}</h2>
          <button
            type="button"
            aria-label="Fermer"
            onClick={onClose}
            className="rounded px-2 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <div className="px-6 py-5">{children}</div>

        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-6 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
