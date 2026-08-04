import { z } from 'zod';

/**
 * Permissions grantable to a subuser on one server.
 *
 * Format is `<domain>.<action>`. Server owners and panel administrators hold
 * them all implicitly — they are stored only for subusers.
 *
 * This file is the source of truth: the panel checks them on the API side, the
 * daemon receives them in the console JWT and applies them per operation
 * (WebSocket, files, SFTP). Never add a permission on one side only.
 */
export const PERMISSIONS = {
  /** See the console and the server name. Implicit for every subuser. */
  WEBSOCKET_CONNECT: 'websocket.connect',

  CONTROL_CONSOLE: 'control.console',
  CONTROL_START: 'control.start',
  CONTROL_STOP: 'control.stop',
  CONTROL_RESTART: 'control.restart',

  USER_CREATE: 'user.create',
  USER_READ: 'user.read',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',

  FILE_READ: 'file.read',
  /** Read file contents, not just list the directory. */
  FILE_READ_CONTENT: 'file.read-content',
  FILE_CREATE: 'file.create',
  FILE_UPDATE: 'file.update',
  FILE_DELETE: 'file.delete',
  FILE_ARCHIVE: 'file.archive',
  FILE_SFTP: 'file.sftp',

  BACKUP_CREATE: 'backup.create',
  BACKUP_READ: 'backup.read',
  BACKUP_DELETE: 'backup.delete',
  BACKUP_DOWNLOAD: 'backup.download',
  BACKUP_RESTORE: 'backup.restore',

  DATABASE_READ: 'database.read',
  DATABASE_CREATE: 'database.create',
  DATABASE_UPDATE: 'database.update',
  DATABASE_DELETE: 'database.delete',

  ALLOCATION_READ: 'allocation.read',
  ALLOCATION_CREATE: 'allocation.create',
  ALLOCATION_UPDATE: 'allocation.update',
  ALLOCATION_DELETE: 'allocation.delete',

  STARTUP_READ: 'startup.read',
  STARTUP_UPDATE: 'startup.update',
  STARTUP_DOCKER_IMAGE: 'startup.docker-image',

  SCHEDULE_CREATE: 'schedule.create',
  SCHEDULE_READ: 'schedule.read',
  SCHEDULE_UPDATE: 'schedule.update',
  SCHEDULE_DELETE: 'schedule.delete',

  WEBHOOK_READ: 'webhook.read',
  WEBHOOK_CREATE: 'webhook.create',
  WEBHOOK_UPDATE: 'webhook.update',
  WEBHOOK_DELETE: 'webhook.delete',

  SETTINGS_RENAME: 'settings.rename',
  SETTINGS_REINSTALL: 'settings.reinstall',

  ACTIVITY_READ: 'activity.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Zod schema derived from the constant above: one list to maintain. */
export const permissionSchema = z.enum(PERMISSIONS);

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

/** Granted to every subuser as soon as they are added to a server. */
export const IMPLICIT_PERMISSIONS: readonly Permission[] = [PERMISSIONS.WEBSOCKET_CONNECT];

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Drops unknown values from a permission list.
 *
 * Useful after a database read: a permission removed from the code in a later
 * version must not break loading a subuser.
 */
export function sanitizePermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission);
}

/** Display groups for the interface. Key order is render order. */
export const PERMISSION_GROUPS: Record<
  string,
  { label: string; description: string; permissions: Permission[] }
> = {
  control: {
    label: 'Contrôle du serveur',
    description:
      'Allumer, éteindre et redémarrer le serveur, et lui envoyer des commandes par la console.',
    permissions: [
      PERMISSIONS.CONTROL_CONSOLE,
      PERMISSIONS.CONTROL_START,
      PERMISSIONS.CONTROL_STOP,
      PERMISSIONS.CONTROL_RESTART,
    ],
  },
  user: {
    label: 'Sous-utilisateurs',
    description:
      'Gérer les accès des autres comptes à ce serveur. Personne ne peut accorder une permission ' +
      "qu'il ne possède pas lui-même, ni modifier son propre accès.",
    permissions: [
      PERMISSIONS.USER_READ,
      PERMISSIONS.USER_CREATE,
      PERMISSIONS.USER_UPDATE,
      PERMISSIONS.USER_DELETE,
    ],
  },
  file: {
    label: 'Fichiers',
    description:
      'Parcourir, modifier et envoyer les fichiers du serveur, depuis le panel comme par SFTP.',
    permissions: [
      PERMISSIONS.FILE_READ,
      PERMISSIONS.FILE_READ_CONTENT,
      PERMISSIONS.FILE_CREATE,
      PERMISSIONS.FILE_UPDATE,
      PERMISSIONS.FILE_DELETE,
      PERMISSIONS.FILE_ARCHIVE,
      PERMISSIONS.FILE_SFTP,
    ],
  },
  backup: {
    label: 'Sauvegardes',
    description: 'Créer, télécharger et restaurer les archives complètes du serveur.',
    permissions: [
      PERMISSIONS.BACKUP_READ,
      PERMISSIONS.BACKUP_CREATE,
      PERMISSIONS.BACKUP_DELETE,
      PERMISSIONS.BACKUP_DOWNLOAD,
      PERMISSIONS.BACKUP_RESTORE,
    ],
  },
  database: {
    label: 'Bases de données',
    description:
      'Créer et consulter les bases MySQL du serveur. Les consulter, c’est en voir le mot ' +
      'de passe : cette permission donne accès à leur contenu.',
    permissions: [
      PERMISSIONS.DATABASE_READ,
      PERMISSIONS.DATABASE_CREATE,
      PERMISSIONS.DATABASE_UPDATE,
      PERMISSIONS.DATABASE_DELETE,
    ],
  },
  allocation: {
    label: 'Ports',
    description: 'Consulter et modifier les adresses et ports sur lesquels le serveur écoute.',
    permissions: [
      PERMISSIONS.ALLOCATION_READ,
      PERMISSIONS.ALLOCATION_CREATE,
      PERMISSIONS.ALLOCATION_UPDATE,
      PERMISSIONS.ALLOCATION_DELETE,
    ],
  },
  startup: {
    label: 'Démarrage',
    description:
      'Modifier la commande de lancement, les variables du template et la version de Java utilisée.',
    permissions: [
      PERMISSIONS.STARTUP_READ,
      PERMISSIONS.STARTUP_UPDATE,
      PERMISSIONS.STARTUP_DOCKER_IMAGE,
    ],
  },
  schedule: {
    label: 'Tâches planifiées',
    description:
      'Programmer des commandes, des redémarrages et des sauvegardes à des horaires donnés.',
    permissions: [
      PERMISSIONS.SCHEDULE_READ,
      PERMISSIONS.SCHEDULE_CREATE,
      PERMISSIONS.SCHEDULE_UPDATE,
      PERMISSIONS.SCHEDULE_DELETE,
    ],
  },
  webhook: {
    label: 'Notifications',
    description:
      'Déclarer des adresses prévenues des événements du serveur — Discord, ou n’importe quel ' +
      'service qui accepte une requête entrante.',
    permissions: [
      PERMISSIONS.WEBHOOK_READ,
      PERMISSIONS.WEBHOOK_CREATE,
      PERMISSIONS.WEBHOOK_UPDATE,
      PERMISSIONS.WEBHOOK_DELETE,
    ],
  },
  settings: {
    label: 'Paramètres',
    description: "Renommer le serveur, le réinstaller et consulter son journal d'activité.",
    permissions: [
      PERMISSIONS.SETTINGS_RENAME,
      PERMISSIONS.SETTINGS_REINSTALL,
      PERMISSIONS.ACTIVITY_READ,
    ],
  },
};

/**
 * Label and description of each permission.
 *
 * Next to the enumeration rather than in the interface: a permission
 * ajoutée sans son explication se verrait immédiatement — la table est
 * exhaustive par construction — alors qu'une table tenue à part dériverait en
 * silence, et l'utilisateur se retrouverait à cocher une case dont personne ne
 * sait plus ce qu'elle ouvre.
 *
 * Ces textes seront extraits vers les fichiers de traduction en phase 7 ; d'ici
 * là, le panel est monolingue et les sortir ici n'apporterait rien.
 */
export const PERMISSION_DETAILS: Record<Permission, { label: string; description: string }> = {
  [PERMISSIONS.WEBSOCKET_CONNECT]: {
    label: 'Se connecter',
    description:
      "Voir le serveur et sa console en lecture seule. Accordée d'office : sans elle, un " +
      'sous-utilisateur ne verrait pas le serveur auquel on vient de lui donner accès.',
  },

  [PERMISSIONS.CONTROL_CONSOLE]: {
    label: 'Envoyer des commandes',
    description:
      "Taper des commandes dans la console. Équivaut à la console d'administration du jeu : " +
      "une commande peut donner l'opérateur à n'importe qui.",
  },
  [PERMISSIONS.CONTROL_START]: {
    label: 'Démarrer',
    description: "Allumer le serveur lorsqu'il est arrêté.",
  },
  [PERMISSIONS.CONTROL_STOP]: {
    label: 'Arrêter',
    description:
      "Éteindre le serveur, et le tuer si l'arrêt propre échoue. Un serveur tué peut perdre " +
      'les derniers changements du monde.',
  },
  [PERMISSIONS.CONTROL_RESTART]: {
    label: 'Redémarrer',
    description: 'Relancer le serveur. Permet de le démarrer, mais pas de le laisser éteint.',
  },

  [PERMISSIONS.USER_READ]: {
    label: 'Voir les accès',
    description: 'Consulter la liste des sous-utilisateurs et les permissions de chacun.',
  },
  [PERMISSIONS.USER_CREATE]: {
    label: 'Ajouter un accès',
    description: 'Ouvrir le serveur à un compte existant du panel.',
  },
  [PERMISSIONS.USER_UPDATE]: {
    label: 'Modifier les accès',
    description: "Changer les permissions d'un autre sous-utilisateur.",
  },
  [PERMISSIONS.USER_DELETE]: {
    label: 'Retirer un accès',
    description: "Révoquer l'accès d'un autre sous-utilisateur au serveur.",
  },

  [PERMISSIONS.FILE_READ]: {
    label: 'Parcourir',
    description:
      'Lister les dossiers et voir les noms, tailles et dates, sans ouvrir les fichiers.',
  },
  [PERMISSIONS.FILE_READ_CONTENT]: {
    label: 'Lire le contenu',
    description:
      'Ouvrir et télécharger les fichiers. Les configurations de plugins contiennent souvent ' +
      'des mots de passe de base de données.',
  },
  [PERMISSIONS.FILE_CREATE]: {
    label: 'Créer et envoyer',
    description:
      'Créer des dossiers et envoyer des fichiers. Déposer un greffon revient à faire exécuter ' +
      'du code par le serveur.',
  },
  [PERMISSIONS.FILE_UPDATE]: {
    label: 'Modifier',
    description: 'Écrire dans les fichiers, les renommer, les déplacer et changer leurs droits.',
  },
  [PERMISSIONS.FILE_DELETE]: {
    label: 'Supprimer',
    description: 'Effacer des fichiers et des dossiers, monde compris.',
  },
  [PERMISSIONS.FILE_ARCHIVE]: {
    label: 'Compresser et extraire',
    description: 'Créer des archives et en extraire le contenu dans le dossier du serveur.',
  },
  [PERMISSIONS.FILE_SFTP]: {
    label: 'Accès SFTP',
    description:
      'Se connecter en SFTP avec ses identifiants du panel. Les permissions de fichiers ' +
      "ci-dessus s'y appliquent également.",
  },

  [PERMISSIONS.BACKUP_READ]: {
    label: 'Voir les sauvegardes',
    description: 'Consulter la liste des sauvegardes et leur état.',
  },
  [PERMISSIONS.BACKUP_CREATE]: {
    label: 'Créer',
    description:
      'Lancer une sauvegarde. Une fois la limite atteinte, la plus ancienne non verrouillée ' +
      'est remplacée.',
  },
  [PERMISSIONS.BACKUP_DELETE]: {
    label: 'Supprimer et verrouiller',
    description: 'Effacer une sauvegarde, et poser ou retirer le verrou qui la protège.',
  },
  [PERMISSIONS.BACKUP_DOWNLOAD]: {
    label: 'Télécharger',
    description: 'Emporter une copie complète du serveur, monde et configurations compris.',
  },
  [PERMISSIONS.BACKUP_RESTORE]: {
    label: 'Restaurer',
    description:
      "Remettre le serveur dans l'état d'une sauvegarde. Efface tout ce qui a été fait depuis.",
  },

  [PERMISSIONS.DATABASE_READ]: {
    label: 'Voir les bases',
    description:
      'Consulter les bases du serveur, mot de passe compris : cette permission donne ' +
      'accès à tout leur contenu.',
  },
  [PERMISSIONS.DATABASE_CREATE]: {
    label: 'Créer une base',
    description: 'Créer une base MySQL et son compte dédié, dans la limite autorisée au serveur.',
  },
  [PERMISSIONS.DATABASE_UPDATE]: {
    label: 'Changer le mot de passe',
    description:
      "Régénérer le mot de passe d'une base. L'ancien cesse aussitôt de fonctionner : les " +
      'plugins configurés avec lui perdront la connexion.',
  },
  [PERMISSIONS.DATABASE_DELETE]: {
    label: 'Supprimer une base',
    description: 'Effacer une base et son contenu. Cette action est irréversible.',
  },

  [PERMISSIONS.ALLOCATION_READ]: {
    label: 'Voir les ports',
    description: 'Consulter les adresses et ports attribués au serveur.',
  },
  [PERMISSIONS.ALLOCATION_CREATE]: {
    label: 'Ajouter un port',
    description:
      'Attribuer un port supplémentaire au serveur, pour une carte dynamique par exemple.',
  },
  [PERMISSIONS.ALLOCATION_UPDATE]: {
    label: 'Modifier les ports',
    description: 'Changer le port principal et les libellés des ports attribués.',
  },
  [PERMISSIONS.ALLOCATION_DELETE]: {
    label: 'Retirer un port',
    description: 'Rendre un port supplémentaire au node.',
  },

  [PERMISSIONS.STARTUP_READ]: {
    label: 'Voir le démarrage',
    description: 'Consulter la commande de lancement et les variables du template.',
  },
  [PERMISSIONS.STARTUP_UPDATE]: {
    label: 'Modifier le démarrage',
    description:
      'Changer les variables du template, dont le fichier exécuté au lancement du serveur.',
  },
  [PERMISSIONS.STARTUP_DOCKER_IMAGE]: {
    label: "Changer l'image Docker",
    description:
      'Choisir la version de Java qui exécute le serveur, parmi celles proposées par le template.',
  },

  [PERMISSIONS.SCHEDULE_READ]: {
    label: 'Voir les tâches',
    description: 'Consulter les tâches planifiées et leurs prochaines exécutions.',
  },
  [PERMISSIONS.SCHEDULE_CREATE]: {
    label: 'Créer une tâche',
    description: 'Programmer des commandes, redémarrages et sauvegardes automatiques.',
  },
  [PERMISSIONS.SCHEDULE_UPDATE]: {
    label: 'Modifier et exécuter',
    description: "Changer l'horaire et les étapes d'une tâche, et la déclencher immédiatement.",
  },
  [PERMISSIONS.SCHEDULE_DELETE]: {
    label: 'Supprimer une tâche',
    description: 'Retirer définitivement une tâche planifiée.',
  },

  [PERMISSIONS.SETTINGS_RENAME]: {
    label: 'Renommer',
    description: 'Changer le nom et la description du serveur dans le panel.',
  },
  [PERMISSIONS.SETTINGS_REINSTALL]: {
    label: 'Réinstaller',
    description:
      "Relancer le script d'installation du template. Selon le template, les fichiers du " +
      'serveur peuvent être écrasés.',
  },
  [PERMISSIONS.ACTIVITY_READ]: {
    label: "Voir l'activité",
    description: 'Consulter le journal des actions menées sur ce serveur et par qui.',
  },

  [PERMISSIONS.WEBHOOK_READ]: {
    label: 'Voir les notifications',
    description: 'Consulter les adresses prévenues des événements du serveur.',
  },
  [PERMISSIONS.WEBHOOK_CREATE]: {
    label: 'Ajouter une notification',
    description:
      'Déclarer une adresse que le panel appellera. Le panel émet alors une requête sortante vers ' +
      'une adresse choisie par le titulaire de cette permission.',
  },
  [PERMISSIONS.WEBHOOK_UPDATE]: {
    label: 'Modifier une notification',
    description: 'Changer l’adresse, les événements souscrits ou l’état d’une notification.',
  },
  [PERMISSIONS.WEBHOOK_DELETE]: {
    label: 'Supprimer une notification',
    description: 'Retirer une adresse prévenue.',
  },
};

/**
 * Permissions dangereuses : elles permettent à un sous-utilisateur d'obtenir
 * l'exécution de code sur le serveur ou d'en détruire les données. L'interface
 * doit les signaler visuellement au moment de les accorder.
 */
export const DANGEROUS_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CONTROL_CONSOLE,
  PERMISSIONS.FILE_CREATE,
  PERMISSIONS.FILE_UPDATE,
  PERMISSIONS.FILE_DELETE,
  PERMISSIONS.FILE_SFTP,
  PERMISSIONS.BACKUP_RESTORE,
  PERMISSIONS.STARTUP_UPDATE,
  PERMISSIONS.STARTUP_DOCKER_IMAGE,
  PERMISSIONS.SETTINGS_REINSTALL,
  // Voir une base, c'est en voir le mot de passe, donc en lire et en écrire
  // tout le contenu.
  PERMISSIONS.DATABASE_READ,
  PERMISSIONS.DATABASE_DELETE,
];
