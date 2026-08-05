import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { cx } from '../lib/cx';

/**
 * Modal dialog.
 *
 * Hand-written rather than using the native `<dialog>`: that one imposes its
 * own backdrop, its own centring and a stacking context above the whole
 * document, all of which then has to be undone to match the theme. A hundred
 * lines here give the same behaviour without fighting the browser.
 *
 * Three things easily forgotten that make a modal unpleasant: Escape has to
 * close it, so does a click on the backdrop, and the page behind must stop
 * scrolling — otherwise the wheel slides the document under the box, which then
 * seems to float in mid-air.
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
  /** Actions, right-aligned at the bottom of the box. */
  footer?: ReactNode;
  /** `lg` for dense content — a list of annotated permissions. */
  size?: 'md' | 'lg';
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * `onClose` goes through a ref rather than the effect's dependencies.
   *
   * The caller nearly always writes it inline — `onClose={() => setOpen(false)}`
   * — so a fresh function on every render. Placed in the dependencies, it
   * replayed the effect on *every* render of the parent: focus jumped back to
   * the box's first field and the body's scrolling was restored then suspended
   * again. In practice, clicking into a textarea while the page refreshed in
   * the background sent the caret elsewhere.
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

    // Focus moves into the box: without it, focus would stay on the button
    // that opened it, and tabbing would walk the page behind.
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
    // Deliberately limited to `open`: the effect sets the opening up and tears
    // it down, it must not replay on a mere render.
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      // A darkened backdrop, without `backdrop-blur`: blurring the whole
      // background forces the compositor to recompute it on every frame, over
      // the entire window. The cost is invisible on a still page and very
      // noticeable as soon as something animates behind.
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16"
      // The click only closes if it starts **and** ends on the backdrop: a
      // text selection begun in a field and released outside would otherwise
      // close the box and lose what was typed.
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
            aria-label={t('common.close')}
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
