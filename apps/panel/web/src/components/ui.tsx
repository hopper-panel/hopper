import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx';

/**
 * Briques d'interface partagées.
 *
 * Volontairement peu nombreuses et sans bibliothèque de composants : le panel a
 * besoin de six primitives, pas d'un design system. Elles vivront ici tant
 * qu'elles tiennent dans un fichier.
 */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface hover:bg-accent-strong font-medium',
  secondary: 'bg-surface-raised text-content hover:bg-surface-hover border border-border-subtle',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/40',
  ghost: 'text-content-muted hover:text-content hover:bg-surface-hover',
};

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  /** Texte, ou contenu riche — une aide comportant du code par exemple. */
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-content">{label}</span>
      {children}
      {/* L'erreur remplace l'aide plutôt que de s'y ajouter : deux lignes de
          texte sous un champ font perdre laquelle compte. */}
      {error ? (
        <span className="block text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="block text-xs text-content-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content',
        'placeholder:text-content-muted focus:border-accent focus:outline-none',
        'disabled:opacity-50',
        className,
      )}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-xl border border-border-subtle bg-surface-raised p-5 shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = 'offline',
  children,
}: {
  tone?: 'online' | 'offline' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const tones = {
    online: 'bg-online/15 text-online',
    offline: 'bg-offline/15 text-content-muted',
    warn: 'bg-accent/15 text-accent',
    danger: 'bg-danger/15 text-danger',
  };

  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx(
        'rounded-lg border px-4 py-3 text-sm',
        tone === 'danger'
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-border-subtle bg-surface-raised text-content-muted',
      )}
    >
      {children}
    </div>
  );
}

/**
 * État vide.
 *
 * Toujours accompagné de l'action qui le résout : une liste vide sans bouton
 * laisse l'utilisateur chercher dans le menu ce qu'il aurait dû faire.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle px-6 py-12 text-center">
      <p className="text-content">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-content-muted">{description}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-sm text-content-muted" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-border-subtle border-t-accent" />
      {label}
    </div>
  );
}
