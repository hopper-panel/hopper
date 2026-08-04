import { z } from 'zod';

/**
 * Contract of the file API.
 *
 * The paths travelling here are **always relative to the server's volume**, in
 * POSIX separators (`plugins/config.yml`). The absolute path on the host never
 * crosses this boundary: it would otherwise surface in an error message shown
 * to the user, revealing the node's directory tree.
 */

/** Path supplied by the client. The real validation is done by the jail. */
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
  // Bounded: deleting ten thousand paths in one request would keep the daemon
  // busy long enough for the panel to consider the node offline.
  files: z.array(filePathSchema).min(1).max(500),
});

export const compressFilesRequestSchema = z.object({
  files: z.array(filePathSchema).min(1).max(500),
  /** Dossier de destination de l'archive. */
  directory: filePathSchema.default('/'),
});

export const decompressFileRequestSchema = z.object({
  file: filePathSchema,
  /** Folder to extract into. */
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
 * Largest file that opens in the editor.
 *
 * Past that, a download is offered rather than editing: loading a 200 MiB
 * region file into a text editor freezes the tab, and the user has nothing to
 * hand-edit in it anyway.
 */
export const MAX_EDITABLE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Largest upload, per file.
 *
 * This is **not** a disk quota: nothing stops anyone uploading a thousand
 * one-gigabyte files. It is a bound against the accident — the 60 GiB modpack
 * dropped in by mistake — until per-server quotas exist.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export const downloadFileQuerySchema = z.object({
  file: z.string().min(1),
});

export const uploadFileQuerySchema = z.object({
  /** Destination folder, relative to the volume root. */
  directory: z.string().min(1).default('/'),
  /**
   * Name of the uploaded file — a name, not a path.
   *
   * The jail guarantees no write leaves the volume, but it **folds** paths back
   * instead of refusing them: `../../../etc/cron.d/door` becomes
   * `etc/cron.d/door` *inside* the volume. Nothing escapes the boundary, but
   * the file lands somewhere other than the folder on screen, and the response
   * reports success. So a name is validated for what it is here, where the
   * contract defines it.
   */
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) => !/[/\\]/.test(value) && value !== '.' && value !== '..',
      'A file name may contain neither a path separator nor "..".',
    ),
});

/**
 * POSIX permissions in octal notation.
 *
 * The `setuid` bit is deliberately out of reach: a setuid binary dropped in a
 * volume would run with its owner's rights, which would defeat the container
 * boundary. Three digits cover everything a Minecraft server asks for.
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
