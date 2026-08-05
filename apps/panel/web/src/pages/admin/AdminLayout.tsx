import { NavLink, Outlet } from 'react-router-dom';
import { Alert } from '../../components/ui';
import { useTranslation, type MessageKey } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { cx } from '../../lib/cx';

/**
 * Administration area.
 *
 * A sidebar rather than tabs: the sections have nothing to do with one another
 * — machines, accounts, templates — and a horizontal bar would have put them on
 * the same footing as the tabs of a server, which all describe one object.
 *
 * The guard below is cosmetic: every administration route already demands the
 * role on the API side. It only avoids rendering a screen full of 403s.
 */
const SECTIONS: {
  title: MessageKey;
  items: { to: string; label: MessageKey; icon: string; end?: boolean }[];
}[] = [
  {
    title: 'admin.sectionAdministration',
    items: [
      { to: '/admin', label: 'admin.overview', icon: '⌂', end: true },
      { to: '/admin/settings', label: 'admin.settings', icon: '⚙' },
    ],
  },
  {
    title: 'admin.sectionOperations',
    items: [
      { to: '/admin/nodes', label: 'admin.nodes', icon: '▦' },
      { to: '/admin/servers', label: 'admin.servers', icon: '▤' },
      { to: '/admin/users', label: 'admin.users', icon: '◍' },
      { to: '/admin/database-hosts', label: 'admin.databaseHosts', icon: '◫' },
    ],
  },
  {
    title: 'admin.sectionCatalogue',
    items: [{ to: '/admin/templates', label: 'admin.templates', icon: '❐' }],
  },
];

export function AdminLayout() {
  const { user } = useAuth();
  const { t } = useTranslation();

  if (user?.role !== 'ADMIN') {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <Alert>This section is reserved for panel administrators.</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-8">
      {/* `sticky`: the section list stays reachable at the bottom of a long
          page, without scrolling back up. */}
      <aside className="sticky top-8 hidden h-fit w-56 shrink-0 lg:block">
        <nav className="flex flex-col gap-6">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-content-subtle">
                {t(section.title)}
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

      {/* On a small screen the sidebar becomes a scrolling row: stacking it
          above the content would push that content off screen. */}
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
  label: MessageKey;
  icon: string;
  end?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();

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
      {t(label)}
    </NavLink>
  );
}
