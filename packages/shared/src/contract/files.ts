import { z } from 'zod';

/**
 * Contrat de l'API fichiers.
 *
 * Les chemins qui circulent ici sont **toujours relatifs au volume du serveur**,
 * en séparateurs POSIX (`plugins/config.yml`). Le chemin absolu sur la machine
 * hôte ne franchit jamais cette frontière : il apparaîtrait sinon dans un
 * message d'erreur affiché à l'utilisateur, révélant l'arborescence du node.
 */

/** Chemin fourni par le client. La validation réelle est faite par le jail. */
const filePathSchema = z.string().min(1).max(4096);

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  directory: z.boolean(),
  symlink: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  /** Permissions POSIX lisibles, ex. `rw-r--r--`. */
  mode: z.string(),
  modifiedAt: z.coerce.date(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

export const listFilesQuerySchema = z.object({
  directory: filePathSchema.default('/'),
});

export const listFilesResponseSchema = z.object({
  directory: z.string(),
  entries: z.array(fileEntrySchema),
});

export const readFileQuerySchema = z.object({
  file: filePathSchema,
});

export const writeFileRequestSchema = z.object({
  file: filePathSchema,
  content: z.string().max(16 * 1024 * 1024),
});

export const createDirectoryRequestSchema = z.object({
  directory: filePathSchema,
});

export const renameFileRequestSchema = z.object({
  from: filePathSchema,
  to: filePathSchema,
});

export const copyFileRequestSchema = z.object({
  from: filePathSchema,
  to: filePathSchema,
});

export const deleteFilesRequestSchema = z.object({
  // Borné : supprimer dix mille chemins en une requête tiendrait le daemon
  // occupé assez longtemps pour que le panel considère le node hors ligne.
  files: z.array(filePathSchema).min(1).max(500),
});

export const compressFilesRequestSchema = z.object({
  files: z.array(filePathSchema).min(1).max(500),
  /** Dossier de destination de l'archive. */
  directory: filePathSchema.default('/'),
});

export const decompressFileRequestSchema = z.object({
  file: filePathSchema,
  /** Dossier où extraire. */
  directory: filePathSchema.default('/'),
});

export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
export type ListFilesResponse = z.infer<typeof listFilesResponseSchema>;
export type WriteFileRequest = z.infer<typeof writeFileRequestSchema>;
export type RenameFileRequest = z.infer<typeof renameFileRequestSchema>;
export type CopyFileRequest = z.infer<typeof copyFileRequestSchema>;
export type DeleteFilesRequest = z.infer<typeof deleteFilesRequestSchema>;
export type CompressFilesRequest = z.infer<typeof compressFilesRequestSchema>;
export type DecompressFileRequest = z.infer<typeof decompressFileRequestSchema>;

/**
 * Taille maximale d'un fichier ouvert dans l'éditeur.
 *
 * Au-delà, on propose le téléchargement plutôt que l'édition : charger un
 * fichier de région de 200 Mio dans un éditeur de texte fige l'onglet, et
 * l'utilisateur n'a de toute façon rien à y modifier à la main.
 */
export const MAX_EDITABLE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Taille maximale d'un envoi, par fichier.
 *
 * Ce n'est **pas** un quota de disque : rien n'empêche d'envoyer mille fichiers
 * d'un gigaoctet. C'est une borne contre l'accident — le modpack de 60 Gio
 * glissé par erreur — en attendant les quotas par serveur.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export const downloadFileQuerySchema = z.object({
  file: z.string().min(1),
});

export const uploadFileQuerySchema = z.object({
  /** Dossier de destination, relatif à la racine du volume. */
  directory: z.string().min(1).default('/'),
  /**
   * Nom du fichier envoyé — un nom, pas un chemin.
   *
   * Le jail garantit qu'aucune écriture ne sort du volume, mais il **replie**
   * les chemins au lieu de les refuser : `../../../etc/cron.d/porte` devient
   * `etc/cron.d/porte` *à l'intérieur* du volume. Rien n'échappe au
   * cloisonnement, mais le fichier atterrit ailleurs que dans le dossier
   * affiché, et la réponse annonce un succès. Un nom est donc validé pour ce
   * qu'il est ici, là où le contrat le définit.
   */
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) => !/[/\\]/.test(value) && value !== '.' && value !== '..',
      'Un nom de fichier ne peut contenir ni séparateur de chemin, ni « .. ».',
    ),
});

/**
 * Droits POSIX en notation octale.
 *
 * Le bit `setuid` est volontairement hors de portée : un binaire setuid déposé
 * dans un volume s'exécuterait avec les droits de son propriétaire, ce qui
 * annulerait le cloisonnement du conteneur. Trois chiffres suffisent à tout ce
 * qu'un serveur Minecraft demande.
 */
export const chmodFilesRequestSchema = z.object({
  files: z.array(z.string().min(1)).min(1).max(500),
  mode: z.string().regex(/^[0-7]{3}$/, 'Trois chiffres octaux attendus, par exemple 644.'),
});

export type DownloadFileQuery = z.infer<typeof downloadFileQuerySchema>;
export type UploadFileQuery = z.infer<typeof uploadFileQuerySchema>;
export type ChmodFilesRequest = z.infer<typeof chmodFilesRequestSchema>;

export const DAEMON_FILE_ROUTES = {
  list: (uuid: string) => `/api/servers/${uuid}/files/list`,
  contents: (uuid: string) => `/api/servers/${uuid}/files/contents`,
  write: (uuid: string) => `/api/servers/${uuid}/files/write`,
  createDirectory: (uuid: string) => `/api/servers/${uuid}/files/create-directory`,
  rename: (uuid: string) => `/api/servers/${uuid}/files/rename`,
  copy: (uuid: string) => `/api/servers/${uuid}/files/copy`,
  delete: (uuid: string) => `/api/servers/${uuid}/files/delete`,
  compress: (uuid: string) => `/api/servers/${uuid}/files/compress`,
  decompress: (uuid: string) => `/api/servers/${uuid}/files/decompress`,
  download: (uuid: string) => `/api/servers/${uuid}/files/download`,
  upload: (uuid: string) => `/api/servers/${uuid}/files/upload`,
  chmod: (uuid: string) => `/api/servers/${uuid}/files/chmod`,
} as const;
