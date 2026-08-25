import { useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { cx } from '../lib/cx';
import { SearchDialog } from './SearchDialog';
import { WrongAddressBanner } from './WrongAddressBanner';
import { LogoutIcon, SearchIcon, ServersIcon, SettingsIcon, UsersIcon } from './icons';

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Application shell.
 *
 * The top bar carries icons only. It used to list the administration sections
 * next to "my servers", which mixed two worlds: the user who runs their servers
 * and the administrator who runs the instance.
 */
export function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
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
            <span className="font-semibold">{user?.panelName ?? 'Hopper'}</span>
          </NavLink>

          <nav className="ml-auto flex items-center gap-1">
            <IconButton
              label={t('nav.search')}
              icon={SearchIcon}
              onClick={() => setSearching(true)}
            />
            <IconLink to="/" label={t('nav.servers')} icon={ServersIcon} end />
            {isAdmin ? <IconLink to="/admin" label={t('nav.admin')} icon={SettingsIcon} /> : null}
            <IconLink to="/account" label={t('nav.account')} icon={UsersIcon} />

            <span className="mx-2 hidden text-sm text-content-muted sm:inline">
              {user?.username}
            </span>

            <IconButton
              label={t('nav.signOut')}
              icon={LogoutIcon}
              onClick={() => {
                void logout();
              }}
            />
          </nav>
        </div>
      </header>

      {/* The requirement cannot be enforced at sign-in — you must be signed in
          to turn it on — so it shows as a banner until it is done. */}
      {user?.mustEnableTwoFactor ? (
        <div className="border-b border-accent/40 bg-accent/10">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2.5 text-sm text-content">
            <span>{t('twoFactor.required')}</span>
            <NavLink
              to="/account"
              className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface"
            >
              {t('twoFactor.enable')}
            </NavLink>
          </div>
        </div>
      ) : null}

      <WrongAddressBanner />

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
 * Icon button of the top bar.
 *
 * The label is carried by `title` **and** `aria-label`: the first shows the
 * browser tooltip, the second names the button for a screen reader. An icon
 * alone is readable by neither.
 */
function IconButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: ComponentType<IconProps>;
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
      <Icon className="size-5" />
    </button>
  );
}

function IconLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: ComponentType<IconProps>;
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
      <Icon className="size-5" />
    </NavLink>
  );
}
