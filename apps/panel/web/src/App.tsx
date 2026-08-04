import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Page } from './components/Page';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AccountPage } from './pages/Account';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { PasswordSetupPage } from './pages/PasswordSetup';
import { ServerActivityPage } from './pages/ServerActivity';
import { ServerBackupsPage } from './pages/ServerBackups';
import { ServerDatabasesPage } from './pages/ServerDatabases';
import { ServerDetailPage } from './pages/ServerDetail';
import { ServerFileEditPage } from './pages/ServerFileEdit';
import { ServerFilesPage } from './pages/ServerFiles';
import { ServerLayout } from './pages/ServerLayout';
import { ServerNetworkPage } from './pages/ServerNetwork';
import { ServerSchedulesPage } from './pages/ServerSchedules';
import { ServerSettingsPage } from './pages/ServerSettings';
import { ServerStartupPage } from './pages/ServerStartup';
import { ServerSubusersPage } from './pages/ServerSubusers';
import { ServerWebhooksPage } from './pages/ServerWebhooks';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminDatabaseHostsPage } from './pages/admin/DatabaseHosts';
import { AdminNodeDetailPage } from './pages/admin/NodeDetail';
import { AdminNodesPage } from './pages/admin/Nodes';
import { AdminOverviewPage } from './pages/admin/Overview';
import { AdminServersPage } from './pages/admin/Servers';
import { AdminSettingsPage } from './pages/admin/Settings';
import { AdminTemplatesPage } from './pages/admin/Templates';
import { AdminUsersPage } from './pages/admin/Users';

export function App() {
  const { user, isLoading } = useAuth();

  // Tant que la session n'est pas résolue, afficher l'écran de connexion
  // ferait clignoter l'interface à chaque rechargement d'un utilisateur déjà
  // authentifié.
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        {/* Avant la connexion : son visiteur n'a pas encore de mot de passe. */}
        <Route path="/definir-mot-de-passe" element={<PasswordSetupPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            <Page>
              <DashboardPage />
            </Page>
          }
        />

        <Route path="account" element={<AccountPage />} />

        {/* Les écrans d'un serveur sont des routes filles : ils partagent la
            barre d'onglets, la connexion à la console et les permissions, que
            `ServerLayout` charge une seule fois. */}
        <Route path="server/:uuid" element={<ServerLayout />}>
          <Route index element={<ServerDetailPage />} />
          <Route path="files" element={<ServerFilesPage />} />
          <Route path="files/edit" element={<ServerFileEditPage />} />
          <Route path="databases" element={<ServerDatabasesPage />} />
          <Route path="backups" element={<ServerBackupsPage />} />
          <Route path="schedules" element={<ServerSchedulesPage />} />
          <Route path="subusers" element={<ServerSubusersPage />} />
          <Route path="network" element={<ServerNetworkPage />} />
          <Route path="startup" element={<ServerStartupPage />} />
          <Route path="settings" element={<ServerSettingsPage />} />
          <Route path="webhooks" element={<ServerWebhooksPage />} />
          <Route path="activity" element={<ServerActivityPage />} />
        </Route>

        {/* L'administration a sa propre mise en page, avec barre latérale : ses
            sections portent sur l'instance entière et n'ont rien à voir entre
            elles, contrairement aux onglets d'un serveur. */}
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<AdminOverviewPage />} />
          <Route path="nodes" element={<AdminNodesPage />} />
          <Route path="nodes/:uuid" element={<AdminNodeDetailPage />} />
          <Route path="servers" element={<AdminServersPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="database-hosts" element={<AdminDatabaseHostsPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
          <Route path="templates" element={<AdminTemplatesPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
