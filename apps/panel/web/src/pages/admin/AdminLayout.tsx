import { NavLink, Outlet } from 'react-router-dom';
import { Alert } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { cx } from '../../lib/cx';

/**
 * Espace d'administration.
 *
 * Une barre latérale plutôt que des onglets : les sections n'ont rien à voir
 * les unes avec les autres — machines, comptes, templates — et une barre
 * horizontale les aurait mises sur le même plan que les onglets d'un serveur,
 * qui portent tous sur le même objet.
 *
 * Le garde d'accès est purement visuel : chaque route d'administration exige
 * déjà le rôle côté API. Il évite d'afficher un écran qui se remplirait de 403.
 */
const SECTIONS = [
  {
    title: 'Administration',
    items: [{ to: '/admin', label: 'Vue d’ensemble', icon: '⌂', end: true }],
  },
  {
    title: 'Exploitation',
    items: [
      { to: '/admin/nodes', label: 'Nodes', icon: '▦' },
      { to: '/admin/servers', label: 'Serveurs', icon: '▤' },
      { to: '/admin/users', label: 'Utilisateurs', icon: '◍' },
      { to: '/admin/database-hosts', label: 'Bases de données', icon: '◫' },
    ],
  },
  {
    title: 'Catalogue',
    items: [{ to: '/admin/templates', label: 'Templates', icon: '❐' }],
  },
];

export function AdminLayout() {
  const { user } = useAuth();

  if (user?.role !== 'ADMIN') {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <Alert>Cette section est réservée aux administrateurs du panel.</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-8">
      {/* `sticky` : la liste des sections reste atteignable au bas d'une longue
          liste de serveurs, sans avoir à remonter. */}
      <aside className="sticky top-8 hidden h-fit w-56 shrink-0 lg:block">
        <nav className="flex flex-col gap-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-content-subtle">
                {section.title}
              </p>

              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <SidebarLink key={item.to} {...item} />
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Sur petit écran, la barre latérale devient une rangée défilante :
          l'empiler au-dessus du contenu repousserait celui-ci hors de l'écran. */}
      <nav className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 lg:hidden">
        {SECTIONS.flatMap((section) => section.items).map((item) => (
          <SidebarLink key={item.to} {...item} compact />
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function SidebarLink({
  to,
  label,
  icon,
  end,
  compact,
}: {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  compact?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
          compact && 'whitespace-nowrap',
          isActive
            ? 'bg-surface-hover font-medium text-content'
            : 'text-content-muted hover:bg-surface-hover hover:text-content',
        )
      }
    >
      <span aria-hidden className="w-4 text-center">
        {icon}
      </span>
      {label}
    </NavLink>
  );
}
