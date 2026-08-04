import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { cx } from '../lib/cx';
import { SearchDialog } from './SearchDialog';

/**
 * Mise en page générale.
 *
 * La barre supérieure ne porte plus que des icônes, comme dans Pterodactyl.
 * Elle listait auparavant les sections d'administration à côté de « Mes
 * serveurs », ce qui mélangeait deux univers : celui de l'utilisateur qui gère
 * ses serveurs, et celui de l'administrateur qui gère l'instance. Le second a
 * désormais son propre espace, avec sa propre navigation.
 */
export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const isAdmin = user?.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-border-subtle bg-surface-raised">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <NavLink to="/" className="flex items-center gap-2 text-content">
            <span aria-hidden className="text-lg">
              🪣
            </span>
            <span className="font-semibold">Hopper</span>
          </NavLink>

          <nav className="ml-auto flex items-center gap-1">
            <IconButton label="Rechercher" icon="🔍" onClick={() => setSearching(true)} />
            <IconLink to="/" label="Mes serveurs" icon="▤" end />
            {isAdmin ? <IconLink to="/admin" label="Administration" icon="⚙" /> : null}
            <IconLink to="/account" label="Mon compte" icon="◍" />

            <span className="mx-2 hidden text-sm text-content-muted sm:inline">
              {user?.username}
            </span>

            <IconButton
              label="Déconnexion"
              icon="⏻"
              onClick={() => {
                void logout();
              }}
            />
          </nav>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <SearchDialog
        open={searching}
        onClose={() => setSearching(false)}
        onSelect={(uuid) => {
          setSearching(false);
          void navigate(`/server/${uuid}`);
        }}
      />
    </div>
  );
}

/**
 * Bouton d'icône de la barre supérieure.
 *
 * Le libellé est porté par `title` **et** `aria-label` : le premier fait
 * apparaître l'infobulle du navigateur, le second nomme le bouton pour un
 * lecteur d'écran. Une icône seule n'est lisible ni par l'un ni par l'autre.
 */
function IconButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded-lg px-3 py-2 text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
    >
      <span aria-hidden>{icon}</span>
    </button>
  );
}

function IconLink({
  to,
  label,
  icon,
  end,
}: {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        cx(
          'rounded-lg px-3 py-2 transition-colors',
          isActive
            ? 'bg-surface-hover text-content'
            : 'text-content-muted hover:bg-surface-hover hover:text-content',
        )
      }
    >
      <span aria-hidden>{icon}</span>
    </NavLink>
  );
}
