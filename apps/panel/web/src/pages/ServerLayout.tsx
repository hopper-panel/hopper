import type { Permission } from '@hopper/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { Page } from '../components/Page';
import { Alert, Spinner } from '../components/ui';
import { api, type ServerSummary } from '../lib/api';
import { cx } from '../lib/cx';
import type { ServerContext } from '../lib/server-context';
import { useConsole } from '../lib/use-console';

interface Tab {
  /** Chemin relatif à `/server/:uuid`. Vide pour la console. */
  path: string;
  label: string;
  /** Sans elle, l'onglet n'est pas affiché du tout. */
  permission?: Permission;
}

/**
 * Onglets d'un serveur.
 *
 * Seuls figurent ici les écrans qui existent : un onglet grisé ou qui mène à
 * une page vide fait douter de tout le reste de l'interface. Les suivants —
 * s'ajoutent d'une ligne chacun à mesure qu'ils sont écrits.
 */
const TABS: Tab[] = [
  { path: '', label: 'Console' },
  { path: 'files', label: 'Fichiers', permission: 'file.read' },
  { path: 'databases', label: 'Bases de données', permission: 'database.read' },
  { path: 'backups', label: 'Sauvegardes', permission: 'backup.read' },
  { path: 'schedules', label: 'Planificateur', permission: 'schedule.read' },
  { path: 'subusers', label: 'Utilisateurs', permission: 'user.read' },
  { path: 'network', label: 'Réseau', permission: 'allocation.read' },
  { path: 'startup', label: 'Démarrage', permission: 'startup.read' },
  { path: 'webhooks', label: 'Notifications', permission: 'webhook.read' },
  { path: 'settings', label: 'Paramètres' },
  { path: 'activity', label: 'Activité', permission: 'activity.read' },
];

/**
 * Mise en page commune aux écrans d'un serveur.
 *
 * Porte la barre d'onglets, mais surtout **la connexion à la console** : celle-ci
 * appartient au serveur, pas à un écran. Tant qu'elle vivait dans la page de
 * console, passer aux fichiers la fermait et y revenir la rouvrait — une
 * reconnexion complète, avec son clignotement, à chaque aller-retour. Elle
 * survit désormais aux changements d'onglet, ce qui rend aussi l'état du
 * serveur visible partout.
 */
export function ServerLayout() {
  const { uuid = '' } = useParams();
  const controller = useConsole(uuid);

  const server = useQuery({
    queryKey: ['server', uuid],
    queryFn: () => api.get<ServerSummary>(`/api/servers/${uuid}`),
  });

  const access = useQuery({
    queryKey: ['server', uuid, 'permissions'],
    queryFn: () =>
      api.get<{ permissions: Permission[]; isOwner: boolean }>(`/api/servers/${uuid}/permissions`),
  });

  // Le nom du serveur ne figure plus que sur la page de console : le porter
  // dans le titre de l'onglet le garde sous les yeux depuis les autres écrans,
  // et permet de distinguer deux serveurs ouverts côte à côte.
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
          Ce serveur est introuvable ou vous n’y avez pas accès.{' '}
          <Link to="/" className="underline">
            Retour à mes serveurs
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
      {/* Barre d'onglets seule, collée sous la barre supérieure, comme dans
          Pterodactyl. Le nom du serveur en occupait auparavant la ligne
          au-dessus : il est désormais le titre de la page de console, ce qui
          rend au contenu la hauteur d'un bandeau entier. */}
      <div className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto max-w-7xl px-4">
          {/* `-mb-px` fait passer le soulignement de l'onglet actif par-dessus
              la bordure du bandeau, au lieu de le poser juste au-dessus. */}
          <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Sections du serveur">
            {TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => (
              <NavLink
                key={tab.path}
                to={tab.path === '' ? `/server/${uuid}` : `/server/${uuid}/${tab.path}`}
                // Sans `end`, l'onglet Console resterait actif sur toutes les
                // routes filles, puisque son chemin en est le préfixe.
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
                {tab.label}
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
