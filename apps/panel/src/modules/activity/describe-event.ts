import { AUDIT_EVENTS } from '../audit/audit.service.js';

/**
 * Rend une entrée d'audit en une phrase lisible.
 *
 * Écrit côté serveur et non dans l'interface, pour une raison simple : la
 * phrase dépend du contenu de `metadata`, dont la forme varie d'un événement à
 * l'autre et n'est connue que de celui qui l'écrit. La composer dans le
 * navigateur obligerait à publier cette forme, et à la maintenir en deux
 * endroits — le second se contentant bientôt d'afficher `server.updated`.
 *
 * Un événement inconnu n'est pas masqué : mieux vaut une ligne technique qu'un
 * trou dans un journal censé être exhaustif.
 */

type Metadata = Record<string, unknown>;

function text(metadata: Metadata, key: string): string | null {
  const value = metadata[key];

  return typeof value === 'string' && value !== '' ? value : null;
}

function quoted(value: string | null): string {
  return value === null ? '' : ` « ${value} »`;
}

export function describeEvent(event: string, metadata: Metadata): string {
  switch (event) {
    // -- Serveur ------------------------------------------------------------
    case AUDIT_EVENTS.SERVER_CREATED:
      return 'A créé le serveur.';
    case AUDIT_EVENTS.SERVER_DELETED:
      return 'A supprimé le serveur.';
    case AUDIT_EVENTS.SERVER_SUSPENDED:
      return 'A suspendu le serveur.';
    case AUDIT_EVENTS.SERVER_UNSUSPENDED:
      return 'A rétabli le serveur.';
    case AUDIT_EVENTS.SERVER_REINSTALLED:
      return 'A réinstallé le serveur.';

    case AUDIT_EVENTS.SERVER_POWER: {
      const action = text(metadata, 'action');
      const labels: Record<string, string> = {
        start: 'A démarré le serveur.',
        stop: 'A arrêté le serveur.',
        restart: 'A redémarré le serveur.',
        kill: 'A tué le processus du serveur.',
      };

      return (action && labels[action]) ?? 'A changé l’état du serveur.';
    }

    case AUDIT_EVENTS.SERVER_COMMAND:
      return `A exécuté${quoted(text(metadata, 'command'))} dans la console.`;

    // `server.updated` sert de fourre-tout pour les actions détaillées par
    // `metadata.action` : fichiers, démarrage. Le distinguer ici évite d'avoir
    // à créer un événement par opération de fichier.
    case AUDIT_EVENTS.SERVER_UPDATED: {
      // `?? ''` plutôt que `null` : le `switch` couvre ainsi toutes les
      // valeurs possibles et `default` reste la seule sortie.
      const action = text(metadata, 'action') ?? '';

      switch (action) {
        case 'file.write':
          return `A modifié le fichier${quoted(text(metadata, 'file'))}.`;
        case 'file.rename':
          return `A renommé ou déplacé${quoted(text(metadata, 'from'))}.`;
        case 'file.copy':
          return `A copié${quoted(text(metadata, 'from'))}.`;
        case 'file.delete': {
          const files = Array.isArray(metadata.files) ? metadata.files.length : 0;

          return files > 1 ? `A supprimé ${files} fichiers.` : 'A supprimé un fichier.';
        }
        case 'file.create-directory':
          return `A créé le dossier${quoted(text(metadata, 'directory'))}.`;
        case 'file.compress':
          return 'A créé une archive.';
        case 'file.decompress':
          return `A extrait l’archive${quoted(text(metadata, 'file'))}.`;
        case 'file.chmod':
          return `A changé les droits en ${text(metadata, 'mode') ?? '?'}.`;
        case 'upload':
          return `A envoyé le fichier${quoted(text(metadata, 'name'))}.`;
        case 'startup':
          return 'A modifié les paramètres de démarrage.';
        default:
          return 'A modifié le serveur.';
      }
    }

    // -- Sauvegardes --------------------------------------------------------
    case AUDIT_EVENTS.BACKUP_CREATED:
      // Le planificateur et le daemon écrivent aussi cet événement : le second
      // rapporte un verdict, pas une demande.
      return metadata.successful === undefined
        ? `A lancé la sauvegarde${quoted(text(metadata, 'name'))}.`
        : metadata.successful === true
          ? 'Une sauvegarde s’est terminée.'
          : 'Une sauvegarde a échoué.';
    case AUDIT_EVENTS.BACKUP_DELETED:
      return 'A supprimé une sauvegarde.';
    case AUDIT_EVENTS.BACKUP_RESTORED:
      return 'A restauré une sauvegarde.';
    case AUDIT_EVENTS.BACKUP_LOCKED:
      return metadata.locked === true
        ? 'A verrouillé une sauvegarde.'
        : 'A déverrouillé une sauvegarde.';

    // -- Bases de données ---------------------------------------------------
    case AUDIT_EVENTS.DATABASE_CREATED:
      return `A créé la base${quoted(text(metadata, 'database'))}.`;
    case AUDIT_EVENTS.DATABASE_UPDATED:
      return `A changé le mot de passe de la base${quoted(text(metadata, 'database'))}.`;
    case AUDIT_EVENTS.DATABASE_DELETED:
      return 'A supprimé une base de données.';

    // -- Clés d'API ----------------------------------------------------------
    case AUDIT_EVENTS.API_KEY_CREATED:
      return `A créé une clé d’API${quoted(text(metadata, 'memo'))}.`;
    case AUDIT_EVENTS.API_KEY_DELETED:
      return 'A révoqué une clé d’API.';

    // -- Notifications sortantes --------------------------------------------
    case AUDIT_EVENTS.WEBHOOK_CREATED:
      // L'URL figure dans le message : c'est une requête que le panel émettra
      // désormais tout seul, et savoir vers où compte autant que savoir qui.
      return `A ajouté une notification vers${quoted(text(metadata, 'url'))}.`;
    case AUDIT_EVENTS.WEBHOOK_UPDATED:
      return `A modifié une notification vers${quoted(text(metadata, 'url'))}.`;
    case AUDIT_EVENTS.WEBHOOK_DELETED:
      return 'A supprimé une notification.';

    // -- Tâches planifiées --------------------------------------------------
    case AUDIT_EVENTS.SCHEDULE_CREATED:
      return `A créé la tâche planifiée${quoted(text(metadata, 'name'))}.`;
    case AUDIT_EVENTS.SCHEDULE_UPDATED:
      return metadata.manualRun === true
        ? 'A déclenché une tâche planifiée.'
        : 'A modifié une tâche planifiée.';
    case AUDIT_EVENTS.SCHEDULE_DELETED:
      return 'A supprimé une tâche planifiée.';
    case AUDIT_EVENTS.SCHEDULE_RUN: {
      const failures = Array.isArray(metadata.failures) ? metadata.failures.length : 0;

      return failures === 0
        ? `La tâche${quoted(text(metadata, 'schedule'))} s’est exécutée.`
        : `La tâche${quoted(text(metadata, 'schedule'))} s’est exécutée avec ${failures} échec(s).`;
    }

    // -- Sous-utilisateurs --------------------------------------------------
    case AUDIT_EVENTS.SUBUSER_CREATED:
      return 'A donné accès au serveur à un utilisateur.';
    case AUDIT_EVENTS.SUBUSER_UPDATED:
      return 'A modifié les permissions d’un utilisateur.';
    case AUDIT_EVENTS.SUBUSER_DELETED:
      return 'A retiré l’accès d’un utilisateur.';

    default:
      return event;
  }
}
