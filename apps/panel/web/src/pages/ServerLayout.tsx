import type { Permission } from '@hopper/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { Page } from '../components/Page';
import { Alert, Spinner } from '../components/ui';
import { api, type ServerSummary } from '../lib/api';
import { useTranslation, type MessageKey } from '../i18n';
import { cx } from '../lib/cx';
import type { ServerContext } from '../lib/server-context';
import { useConsole } from '../lib/use-console';

interface Tab {
  /** Path relative to `/server/:uuid`. Empty for the console. */
  path: string;
  label: MessageKey;
  /** Without it, the tab is not rendered at all. */
  permission?: Permission;
}

/**
 * Server tabs.
 *
 * Only screens that exist are listed: a greyed-out tab, or one leading to an
 * empty page, casts doubt on the rest of the interface.
 */
const TABS: Tab[] = [
  { path: '', label: 'tab.console' },
  { path: 'files', label: 'tab.files', permission: 'file.read' },
  { path: 'databases', label: 'tab.databases', permission: 'database.read' },
  { path: 'backups', label: 'tab.backups', permission: 'backup.read' },
  { path: 'schedules', label: 'tab.schedules', permission: 'schedule.read' },
  { path: 'subusers', label: 'tab.subusers', permission: 'user.read' },
  { path: 'network', label: 'tab.network', permission: 'allocation.read' },
  { path: 'startup', label: 'tab.startup', permission: 'startup.read' },
  { path: 'webhooks', label: 'tab.webhooks', permission: 'webhook.read' },
  { path: 'settings', label: 'tab.settings' },
  { path: 'activity', label: 'tab.activity', permission: 'activity.read' },
];

/**
 * Layout shared by every screen of a server.
 *
 * It carries the tab bar, but above all **the console connection**: that
 * belongs to the server, not to one screen. While it lived in the console page,
 * switching to Files closed it and coming back reopened it — a full reconnect,
 * flicker included, on every round trip.
 */
export function ServerLayout() {
  const { uuid = '' } = useParams();
  const controller = useConsole(uuid);
  const { t } = useTranslation();

  const server = useQuery({
    queryKey: ['server', uuid],
    queryFn: () => api.get<ServerSummary>(`/api/servers/${uuid}`),
  });

  const access = useQuery({
    queryKey: ['server', uuid, 'permissions'],
    queryFn: () =>
      api.get<{ permissions: Permission[]; isOwner: boolean }>(`/api/servers/${uuid}/permissions`),
  });

  // The server name now appears on the console page only: putting it in the
  // browser tab keeps it in sight from the other screens.
  const name = server.data?.name;

  useEffect(() => {
    if (name === undefined) {
      return;
    }

    document.title = `${name} — Hopper`;

    return () => {
      document.title = 'Hopper';
    };
  }, [name]);

  if (server.isLoading || access.isLoading) {
    return (
      <Page>
        <Spinner />
      </Page>
    );
  }

  if (server.error || !server.data) {
    return (
      <Page>
        <Alert>
          This server does not exist, or you do not have access to it.{' '}
          <Link to="/" className="underline">
            {t('nav.servers')}
          </Link>
        </Alert>
      </Page>
    );
  }

  const permissions = access.data?.permissions ?? [];
  const can = (permission: Permission): boolean => permissions.includes(permission);

  const context: ServerContext = { server: server.data, permissions, controller, can };

  return (
    <>
      {/* Tab bar alone, right under the top bar. The server name used to take
          the row above; it is now the console page title. */}
      <div className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto max-w-7xl px-4">
          {/* `-mb-px` draws the active underline over the band border. */}
          <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t('server.sections')}>
            {TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path === '' ? `/server/${uuid}` : `/server/${uuid}/${tab.path}`}
                // Without `end`, the Console tab would stay active on every
                // child route, since its path is their prefix.
                end={tab.path === ''}
                className={({ isActive }) =>
                  cx(
                    'whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors',
                    isActive
                      ? 'border-accent text-content'
                      : 'border-transparent text-content-muted hover:border-border-subtle hover:text-content',
                  )
                }
              >
                {t(tab.label)}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>

      <Page>
        <Outlet context={context} />
      </Page>
    </>
  );
}
