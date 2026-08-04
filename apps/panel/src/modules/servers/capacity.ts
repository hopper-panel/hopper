/**
 * Contrôle de surallocation d'un node.
 *
 * Un node déclare une capacité (RAM, disque) et un pourcentage de dépassement
 * autorisé. La surallocation est utile : la plupart des serveurs Minecraft
 * n'utilisent jamais leur limite maximale, et refuser d'en placer un de plus
 * sur une machine à moitié vide gâcherait du matériel.
 *
 * Elle est aussi dangereuse : quand tous les serveurs consomment vraiment leur
 * quota, l'OOM killer du noyau tue des processus au hasard. D'où le réglage
 * explicite par node, et une valeur par défaut à 0 — pas de dépassement tant
 * qu'un administrateur ne l'a pas décidé.
 */

export interface CapacityCheck {
  /** Capacité déclarée du node, en octets. 0 = non déclarée. */
  declared: bigint;
  /** Somme des limites déjà attribuées aux serveurs du node. */
  allocated: bigint;
  /** Ce que le nouveau serveur demande. */
  requested: bigint;
  /** Pourcentage de dépassement autorisé. -1 = illimité, 0 = strict. */
  overallocation: number;
}

export interface CapacityVerdict {
  allowed: boolean;
  /** Plafond effectif après application du dépassement autorisé. */
  limit: bigint;
  reason?: string;
}

export function checkCapacity(check: CapacityCheck, label: string): CapacityVerdict {
  // Une capacité non déclarée signifie « je ne veux pas de comptabilité sur ce
  // node ». C'est le cas d'un administrateur qui gère la place à la main.
  if (check.declared === 0n) {
    return { allowed: true, limit: 0n };
  }

  if (check.overallocation < 0) {
    return { allowed: true, limit: 0n };
  }

  const limit = check.declared + (check.declared * BigInt(check.overallocation)) / 100n;
  const wouldBe = check.allocated + check.requested;

  if (wouldBe > limit) {
    return {
      allowed: false,
      limit,
      reason:
        `${label} : le node n'a plus la place. ` +
        `${formatBytes(check.allocated)} déjà attribués sur ${formatBytes(limit)} disponibles, ` +
        `${formatBytes(check.requested)} demandés.`,
    };
  }

  return { allowed: true, limit };
}

/** Formatage lisible, destiné aux messages d'erreur affichés à un humain. */
export function formatBytes(bytes: bigint): string {
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let value = Number(bytes);
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
