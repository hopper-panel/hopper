import { CONSOLE_BUFFER_LINES } from '@hopper/shared';

/**
 * Longueur maximale d'une ligne de console conservée.
 *
 * Un plugin qui journalise une stack trace concaténée, ou un `cat` d'un fichier
 * binaire, produit des lignes de plusieurs mégaoctets. Sans borne, elles
 * s'accumuleraient dans le tampon et seraient rediffusées à chaque connexion
 * d'un navigateur.
 */
export const MAX_LINE_LENGTH = 8192;

const TRUNCATION_SUFFIX = '… [ligne tronquée]';

/**
 * Reconstitue des lignes complètes à partir d'un flux d'octets.
 *
 * Docker livre la sortie d'un conteneur par paquets qui ne s'alignent pas sur
 * les fins de ligne : une même ligne peut arriver en trois morceaux, et un
 * paquet peut contenir dix lignes. Sans ce ré-assemblage, la console afficherait
 * des fragments et les regex de détection de démarrage ne matcheraient jamais.
 */
export class LineAssembler {
  private pending = '';

  /** Consomme un fragment et retourne les lignes complètes qu'il termine. */
  push(chunk: string): string[] {
    this.pending += chunk;

    if (!this.pending.includes('\n')) {
      // Un flux sans retour à la ligne ne doit pas faire croître le tampon
      // indéfiniment : au-delà de la limite, on coupe et on repart.
      if (this.pending.length > MAX_LINE_LENGTH) {
        const line = this.pending.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX;
        this.pending = '';
        return [line];
      }
      return [];
    }

    const parts = this.pending.split('\n');
    // Le dernier élément est incomplet — sauf si le fragment finissait par un
    // retour à la ligne, auquel cas c'est une chaîne vide qu'on garde en attente.
    this.pending = parts.pop() ?? '';

    return parts.map((line) => normalizeLine(line));
  }

  /** Vide le tampon et retourne l'éventuelle ligne partielle restante. */
  flush(): string[] {
    if (this.pending === '') {
      return [];
    }

    const line = normalizeLine(this.pending);
    this.pending = '';
    return [line];
  }
}

function normalizeLine(line: string): string {
  // Les serveurs Minecraft émettent des CRLF ; le \r final passerait pour un
  // caractère de contrôle dans xterm.js et décalerait l'affichage.
  const trimmed = line.replace(/\r+$/, '');

  return trimmed.length > MAX_LINE_LENGTH
    ? trimmed.slice(0, MAX_LINE_LENGTH) + TRUNCATION_SUFFIX
    : trimmed;
}

/**
 * Tampon circulaire des dernières lignes de console.
 *
 * Rejoué à chaque connexion d'un navigateur pour qu'un utilisateur qui ouvre la
 * console voie ce qui vient de se passer, plutôt qu'un écran noir jusqu'à la
 * prochaine ligne du serveur.
 */
export class ConsoleBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly capacity: number = CONSOLE_BUFFER_LINES) {
    if (capacity < 1) {
      throw new Error('La capacité du tampon de console doit être positive.');
    }
  }

  push(line: string): void {
    this.lines.push(line);

    // `shift` sur un tableau de 500 éléments est négligeable comparé au coût
    // d'une structure circulaire plus astucieuse mais plus facile à casser.
    while (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  pushAll(lines: readonly string[]): void {
    lines.forEach((line) => this.push(line));
  }

  /** Copie du contenu, de la plus ancienne à la plus récente. */
  snapshot(): string[] {
    return [...this.lines];
  }

  get size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines.length = 0;
  }
}
