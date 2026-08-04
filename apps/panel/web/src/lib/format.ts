/** Formate une taille en octets pour un humain. 0 signifie « illimité ». */
export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return 'illimité';
  }

  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Formate une **mesure** en octets.
 *
 * `formatBytes` traduit 0 par « illimité », ce qui convient à une limite mais
 * pas à une consommation : un serveur éteint afficherait une mémoire illimitée.
 */
export function formatUsedBytes(bytes: number): string {
  return bytes === 0 ? '0 o' : formatBytes(bytes);
}

/** Pourcentage d'un cœur → nombre de cœurs. 0 signifie « illimité ». */
export function formatCpu(percent: number): string {
  return percent === 0
    ? 'illimité'
    : `${(percent / 100).toFixed(percent % 100 === 0 ? 0 : 1)} cœur${percent > 100 ? 's' : ''}`;
}

/**
 * Durée depuis le démarrage du conteneur, en millisecondes.
 *
 * Les unités nulles de tête sont omises, mais pas celles du milieu : « 2j 0h 5m »
 * se lit sans ambiguïté, « 2j 5m » se confond avec deux jours et cinq minutes de
 * plus qu'il n'y en a. Les secondes disparaissent au-delà d'une journée, où
 * elles n'apprennent plus rien.
 */
export function formatUptime(milliseconds: number): string {
  if (milliseconds <= 0) {
    return 'hors ligne';
  }

  const total = Math.floor(milliseconds / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) {
    return `${days}j ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function formatDate(iso: string | null): string {
  if (!iso) {
    return 'jamais';
  }

  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** Adresse à donner aux joueurs. L'alias prime sur l'IP quand il existe. */
/**
 * Adresse à laquelle un joueur se connecte.
 *
 * Une allocation en `0.0.0.0` signifie « toutes les interfaces de la machine »,
 * pas une adresse joignable : l'afficher telle quelle, ou par un « ce serveur »
 * de remplacement, ne donne rien à copier dans un client Minecraft. C'est le
 * nom d'hôte du node qu'il faut montrer — celui par lequel on l'atteint depuis
 * l'extérieur.
 *
 * Un alias, quand il existe, l'emporte sur tout : c'est le domaine que
 * l'hébergeur annonce à ses joueurs.
 */
export function formatAddress(
  allocation: { ip: string; port: number; alias: string | null } | null,
  nodeFqdn?: string,
): string {
  if (!allocation) {
    return 'aucun port';
  }

  const wildcard = allocation.ip === '0.0.0.0' || allocation.ip === '::';
  const host = allocation.alias ?? (wildcard ? (nodeFqdn ?? allocation.ip) : allocation.ip);

  return `${host}:${allocation.port}`;
}

/**
 * Statut d'un serveur tel qu'il est enregistré en base — à ne pas confondre
 * avec son état d'exécution, qui vient du daemon par WebSocket. Un serveur
 * « prêt » peut être éteint.
 */
const STATUS_LABELS: Record<
  string,
  { label: string; tone: 'online' | 'offline' | 'warn' | 'danger' }
> = {
  INSTALLING: { label: 'Installation', tone: 'warn' },
  INSTALL_FAILED: { label: 'Installation échouée', tone: 'danger' },
  READY: { label: 'Prêt', tone: 'online' },
  SUSPENDED: { label: 'Suspendu', tone: 'danger' },
  DELETING: { label: 'Suppression', tone: 'warn' },
  REINSTALLING: { label: 'Réinstallation', tone: 'warn' },
};

export function describeStatus(status: string) {
  // Un statut inconnu est affiché tel quel plutôt que masqué : il vaut mieux
  // montrer une valeur brute qu'un serveur sans état apparent.
  return STATUS_LABELS[status] ?? { label: status, tone: 'offline' as const };
}
