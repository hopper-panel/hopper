import type { Permission, PowerAction, ResourceUsage } from '@hopper/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { Console } from '../components/Console';
import { CHART_POINTS, ResourceChart } from '../components/ResourceChart';
import {
  AddressIcon,
  ClockIcon,
  CpuIcon,
  DiskIcon,
  DownloadIcon,
  MemoryIcon,
  UploadIcon,
} from '../components/icons';
import { Button } from '../components/ui';
import { copyText } from '../lib/clipboard';
import { cx } from '../lib/cx';
import { formatAddress, formatBytes, formatUptime, formatUsedBytes } from '../lib/format';
import { useServerContext } from '../lib/server-context';
import { useUsageHistory, type ConsoleController } from '../lib/use-console';

const POWER_PERMISSIONS: Record<PowerAction, Permission> = {
  start: 'control.start',
  restart: 'control.restart',
  stop: 'control.stop',
  kill: 'control.stop',
};

/** Couleurs des courbes, lues dans le thème plutôt que codées en dur. */
const PRIMARY_LINE = 'var(--color-accent)';
const SECONDARY_LINE = 'var(--color-online)';

export function ServerDetailPage() {
  // Le serveur, ses permissions et la console viennent de `ServerLayout` :
  // cette page n'est plus qu'un onglet parmi d'autres et ne recharge rien.
  const { server, controller, can } = useServerContext();
  // Abonnement local : les autres onglets ne se rendent plus au rythme des
  // relevés du daemon.
  const history = useUsageHistory(controller, CHART_POINTS);
  const usage = history.at(-1) ?? null;

  const busy = controller.state === 'starting' || controller.state === 'stopping';
  const unlimited = '∞';

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-content">{server.name}</h1>

        <div className="flex flex-wrap gap-2">
          <PowerButton
            action="start"
            label="Démarrer"
            controller={controller}
            can={can}
            variant="primary"
            disabled={busy || controller.state === 'running'}
          />
          <PowerButton
            action="restart"
            label="Redémarrer"
            controller={controller}
            can={can}
            disabled={busy || controller.state === 'offline'}
          />
          <PowerButton
            action="stop"
            label="Arrêter"
            controller={controller}
            can={can}
            variant="danger"
            disabled={busy || controller.state === 'offline'}
          />
          {/* Le SIGKILL n'apparaît que quand il peut servir : un serveur éteint
              n'a rien à tuer, et un bouton toujours présent finit par être
              cliqué à la place d'« Arrêter ». */}
          {controller.state !== 'offline' ? (
            <PowerButton
              action="kill"
              label="Tuer"
              controller={controller}
              can={can}
              variant="ghost"
              disabled={false}
              // Un SIGKILL pendant une sauvegarde de région corrompt la map : on
              // demande confirmation plutôt que d'exposer un bouton ordinaire.
              confirm="Tuer le serveur coupe le processus sans sauvegarde. Une perte de données, voire une corruption de la map, est possible. Continuer ?"
            />
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Console controller={controller} />
        </div>

        {/* Cartes de ressources, une par mesure. Le node, le template et
            l'identifiant du serveur ont migré vers l'onglet Paramètres : ils ne
            changent jamais, et occupaient la place de ce qu'on vient réellement
            surveiller.

            La colonne s'étire sur toute la hauteur de la console — un élément
            de grille l'occupe déjà, restait à répartir les cartes dedans avec
            `flex-1`. Sans cela elles s'arrêtaient aux deux tiers et laissaient
            un vide en bas, d'autant plus visible que la console, elle, descend
            jusqu'en bas. */}
        <div className="flex flex-col gap-3">
          <Stat
            icon={<AddressIcon />}
            label="Adresse"
            value={formatAddress(server.primaryAllocation, server.node.fqdn)}
            mono
            copyable
          />
          <Stat
            icon={<ClockIcon />}
            label="Temps de fonctionnement"
            value={usage ? formatUptime(usage.uptime) : '—'}
          />
          <Stat
            icon={<CpuIcon />}
            label="Processeur"
            value={usage ? `${usage.cpuPercent.toFixed(2)} %` : '—'}
            limit={server.cpuPercent === 0 ? unlimited : `${server.cpuPercent} %`}
          />
          <Stat
            icon={<MemoryIcon />}
            label="Mémoire"
            value={usage ? formatUsedBytes(usage.memoryBytes) : '—'}
            limit={server.memoryBytes === 0 ? unlimited : formatBytes(server.memoryBytes)}
          />
          <Stat
            icon={<DiskIcon />}
            label="Disque"
            value={usage ? formatUsedBytes(usage.diskBytes) : '—'}
            limit={server.diskBytes === 0 ? unlimited : formatBytes(server.diskBytes)}
          />
          <Stat
            icon={<DownloadIcon />}
            label="Réseau (entrant)"
            value={usage ? formatUsedBytes(usage.networkRxBytes) : '—'}
          />
          <Stat
            icon={<UploadIcon />}
            label="Réseau (sortant)"
            value={usage ? formatUsedBytes(usage.networkTxBytes) : '—'}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ResourceChart
          title="Processeur"
          series={[
            {
              label: 'Charge',
              points: history.map((s) => s.cpuPercent),
              color: PRIMARY_LINE,
              fill: true,
            },
          ]}
          // Une limite de CPU sert de plafond : sans elle, l'échelle suit le
          // maximum observé, sinon un serveur discret afficherait une courbe
          // écrasée au ras de l'axe.
          ceiling={server.cpuPercent}
          format={(value) => `${value.toFixed(2)} %`}
        />

        <ResourceChart
          title="Mémoire"
          series={[
            {
              label: 'Utilisée',
              points: history.map((s) => s.memoryBytes),
              color: PRIMARY_LINE,
              fill: true,
            },
          ]}
          ceiling={server.memoryBytes}
          format={formatUsedBytes}
        />

        <ResourceChart
          title="Réseau"
          series={[
            { label: 'entrant', points: rates(history, 'networkRxBytes'), color: PRIMARY_LINE },
            { label: 'sortant', points: rates(history, 'networkTxBytes'), color: SECONDARY_LINE },
          ]}
          format={(value) => `${formatUsedBytes(Math.round(value))}/s`}
        />
      </div>
    </>
  );
}

/**
 * Débit instantané, déduit de deux compteurs cumulés successifs.
 *
 * Le daemon rapporte des totaux depuis le démarrage du conteneur : les tracer
 * tels quels donnerait une droite toujours croissante, où l'on ne verrait
 * aucun pic. Un redémarrage remet les compteurs à zéro et produirait une
 * différence négative — ramenée à zéro plutôt qu'affichée sous l'axe.
 */
function rates(
  history: readonly ResourceUsage[],
  key: 'networkRxBytes' | 'networkTxBytes',
): number[] {
  return history.slice(1).map((sample, index) => Math.max(0, sample[key] - history[index]![key]));
}

function PowerButton({
  action,
  label,
  controller,
  can,
  disabled,
  variant = 'secondary',
  confirm,
}: {
  action: PowerAction;
  label: string;
  controller: ConsoleController;
  can: (permission: Permission) => boolean;
  disabled: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirm?: string;
}) {
  // Masquer plutôt que désactiver : un bouton grisé sans explication laisse
  // croire à une panne. L'API refuserait de toute façon l'action.
  //
  // La permission vient de l'API et non du WebSocket : autrement les boutons
  // apparaissaient d'un coup à la connexion de la console, après un instant où
  // la page semblait n'en offrir aucun.
  if (!can(POWER_PERMISSIONS[action])) {
    return null;
  }

  return (
    <Button
      variant={variant}
      className="min-w-24"
      disabled={disabled || controller.status !== 'connected'}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) {
          return;
        }
        controller.setPower(action);
      }}
    >
      {label}
    </Button>
  );
}

/**
 * Une mesure, dans sa propre carte.
 *
 * Séparées plutôt que listées dans un même encadré : chacune se lit d'un coup
 * d'œil pendant que la console défile, ce qu'une liste dense ne permet pas.
 * L'icône n'est pas décorative — c'est elle qu'on vise du regard quand on
 * cherche une ligne précise dans la colonne.
 */
function Stat({
  icon,
  label,
  value,
  limit,
  mono,
  copyable,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  /** Plafond de la mesure, affiché en retrait à la suite de la valeur. */
  limit?: string;
  mono?: boolean;
  /** Rend la carte cliquable : un clic copie la valeur. */
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-content-muted [&>svg]:size-5">
        {icon}
      </span>

      <div className="min-w-0 text-left">
        <p className="text-xs uppercase tracking-wide text-content-muted">
          {label}
          {/* Le retour tient dans le libellé plutôt que dans une infobulle :
              rien ne distingue un presse-papiers rempli d'un clic sans effet,
              et la copie peut réellement échouer — le panel servi en HTTP n'a
              pas accès à l'API du presse-papiers. */}
          {copied ? <span className="ml-2 text-accent">copié</span> : null}
        </p>
        <p className={`truncate text-content ${mono ? 'font-mono text-sm' : 'font-semibold'}`}>
          {value}
          {limit ? (
            <span className="ml-1 text-xs font-normal text-content-subtle">/ {limit}</span>
          ) : null}
        </p>
      </div>
    </>
  );

  const shell =
    'flex flex-1 items-center gap-3 rounded-xl border border-border-subtle bg-surface-raised p-3';

  if (!copyable) {
    return <div className={shell}>{body}</div>;
  }

  return (
    <button
      type="button"
      title={`Copier ${value}`}
      className={cx(shell, 'w-full text-left transition-colors hover:bg-surface-hover')}
      onClick={() => {
        void copyText(value).then(setCopied);
      }}
    >
      {body}
    </button>
  );
}
