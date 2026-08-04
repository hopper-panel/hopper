import { NODE_TOKEN_ID_LENGTH, NODE_TOKEN_SECRET_LENGTH } from '@hopper/shared';
import { z } from 'zod';

/**
 * Schéma du fichier de configuration du daemon (`/etc/hopper/daemon.yml`).
 *
 * Ce fichier est écrit par l'installeur ou copié depuis le panel : il contient
 * le secret du node et le secret de signature des JWT. Il doit appartenir à root
 * et être en mode 0600 — le daemon refuse de démarrer si ce n'est pas le cas
 * (voir `assertConfigFilePermissions`).
 */

const sslSchema = z
  .object({
    enabled: z.boolean().default(false),
    certificatePath: z.string().optional(),
    keyPath: z.string().optional(),
  })
  .refine((ssl) => !ssl.enabled || (ssl.certificatePath && ssl.keyPath), {
    message: 'certificatePath et keyPath sont requis lorsque ssl.enabled vaut true',
  });

const apiSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(8443),
  ssl: sslSchema.prefault({}),
  /** Taille maximale d'un envoi de fichier, en octets. */
  uploadLimitBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  /**
   * Origines autorisées à ouvrir un WebSocket vers ce daemon. Doit contenir
   * l'URL publique du panel. Une liste vide bloque toute connexion navigateur.
   */
  allowedOrigins: z.array(z.string()).default([]),
});

const panelSchema = z.object({
  /** URL publique du panel, ex. `https://panel.example.com`. */
  url: z.url(),
  /**
   * Secret partagé avec le panel, utilisé pour vérifier la signature des JWT de
   * console et des URL signées. Distinct du secret du node : le premier signe
   * des jetons destinés aux navigateurs, le second authentifie le panel lui-même.
   */
  jwtSecret: z.string().min(32),
});

const systemSchema = z.object({
  /** Racine des données du daemon. Tout le reste en dérive par défaut. */
  rootDirectory: z.string().default('/var/lib/hopper'),
  /** Volumes des serveurs, un sous-dossier par UUID. */
  dataDirectory: z.string().optional(),
  backupDirectory: z.string().optional(),
  /**
   * Format de compression des sauvegardes.
   *
   * `gzip` par défaut, et ce n'est pas le choix le plus efficace : zstd
   * compresse un monde Minecraft nettement plus vite, à taux comparable. Mais
   * une archive `.tar.zst` ne s'ouvre pas sans outil dédié — l'explorateur de
   * Windows n'en fait rien, et l'utilisateur se retrouve avec une sauvegarde
   * qu'il ne peut pas consulter. Une sauvegarde illisible par celui qui la
   * télécharge ne remplit qu'à moitié son office.
   *
   * Les archives déjà produites restent restaurables et téléchargeables quel
   * que soit ce réglage : le format est inscrit dans le nom du fichier.
   */
  backupCompression: z.enum(['gzip', 'zstd']).default('gzip'),
  /** Archives temporaires (compression, envois en cours). Purgé au démarrage. */
  tmpDirectory: z.string().optional(),
  /** UID/GID appliqués aux fichiers des serveurs sur l'hôte. */
  uid: z.number().int().nonnegative().default(988),
  gid: z.number().int().nonnegative().default(988),
  timezone: z.string().default('UTC'),
  sftp: z
    .object({
      enabled: z.boolean().default(true),
      bindAddress: z.string().default('0.0.0.0'),
      bindPort: z.number().int().min(1).max(65535).default(2022),
      /** Clé d'hôte SSH. Générée par l'installeur si absente. */
      hostKeyPath: z.string().optional(),
    })
    .prefault({}),
});

const dockerSchema = z.object({
  socket: z.string().default('/var/run/docker.sock'),
  network: z
    .object({
      /** Réseau bridge dédié : isole les serveurs du réseau bridge par défaut. */
      name: z.string().default('hopper0'),
      /** Créer le réseau au démarrage s'il n'existe pas. */
      autoCreate: z.boolean().default(true),
      subnet: z.string().default('172.28.0.0/16'),
      gateway: z.string().default('172.28.0.1'),
      enableIpv6: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Retirer les images inutilisées après une mise à jour de template.
   * Désactivé par défaut : sur un hôte partagé, purger les images d'autrui
   * serait hostile.
   */
  pruneUnusedImages: z.boolean().default(false),

  /**
   * Appliquer le poids d'E/S bloc (`BlkioWeight`) défini par serveur.
   *
   * Désactivé par défaut car c'est une capacité de l'hôte, pas un réglage
   * anodin : en cgroup v2, `io.weight` n'existe que si l'ordonnanceur BFQ est
   * actif. Sur un noyau utilisant mq-deadline — le défaut de la plupart des
   * distributions, et le cas de Docker Desktop — le conteneur refuse
   * simplement de démarrer avec un message OCI illisible.
   *
   * Pour l'activer : `cat /sys/block/<disque>/queue/scheduler` doit mentionner
   * `[bfq]`.
   */
  blkioWeight: z.boolean().default(false),
});

export const daemonConfigSchema = z.object({
  debug: z.boolean().default(false),
  /** UUID du node, tel qu'affiché dans le panel. */
  uuid: z.uuid(),
  tokenId: z.string().length(NODE_TOKEN_ID_LENGTH),
  tokenSecret: z.string().length(NODE_TOKEN_SECRET_LENGTH),

  // `prefault` et non `default` : la valeur `{}` traverse le schéma, ce qui
  // applique récursivement les valeurs par défaut de chaque champ. Avec
  // `default`, Zod 4 exigerait un objet déjà complet.
  api: apiSchema.prefault({}),
  panel: panelSchema,
  system: systemSchema.prefault({}),
  docker: dockerSchema.prefault({}),
});

export type DaemonConfigInput = z.input<typeof daemonConfigSchema>;
export type DaemonConfig = z.infer<typeof daemonConfigSchema>;
