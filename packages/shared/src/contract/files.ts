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
 * Extensions the file manager never opens in the editor.
 *
 * A **deny** list, and the direction is the whole point. An allow list came
 * first and behaved as an allow list does: it named the dozen extensions a
 * Minecraft server has, and everything that was not one hit a wall. A folder of
 * Garry's Mod `.lua`, a Skript `.sk`, a `Dockerfile`, a `.env` — all plainly
 * editable text, all offered as downloads because nobody had thought to add
 * them, and no way for the user to insist.
 *
 * Named here is only what is certainly *not* text: archives, images, sounds,
 * compiled code, databases and a game's world data. Everything else — a known
 * extension, an unknown one, or none at all — goes to the editor, where the
 * daemon has the last word by looking at the bytes.
 */
export const BINARY_FILE_EXTENSIONS =
  /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|lz4|jar|war|class|dll|pdb|exe|so|dylib|bin|obj|msi|deb|rpm|png|jpe?g|gif|bmp|ico|webp|tiff?|tga|psd|xcf|mp3|ogg|wav|flac|aac|mp4|mkv|avi|mov|webm|ttf|otf|woff2?|eot|pdf|docx?|xlsx?|odt|ods|db|sqlite3?|mdb|idx|pack|mca|mcr|nbt|schematic|litematic|vpk|gma|bsp|vtf|gcf)$/i;

/**
 * Whether a name alone is enough to rule the editor out.
 *
 * A hint, not a verdict: it spares a round trip on the file nobody meant to
 * read as text, and it is wrong the moment somebody names a text file `.dat`.
 * `looksBinary` is what actually decides.
 */
export function isProbablyBinaryName(name: string): boolean {
  return BINARY_FILE_EXTENSIONS.test(name);
}

/**
 * How much of a file is examined before calling it text.
 *
 * The same 8000 bytes git reads, and for the same reason: far enough in to
 * catch a header that opens with plausible ASCII, short enough that the check
 * costs a single read.
 */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * Whether the beginning of a file says it is not text.
 *
 * The test is a NUL byte, which is git's, and it is chosen for being *narrow*.
 * Refusing invalid UTF-8 instead would also refuse the Latin-1 `server.properties`
 * that a decade of Minecraft servers are full of — files people legitimately
 * edit, and that no other tool has ever objected to. A NUL byte, on the other
 * hand, appears in no text file anybody meant to write.
 */
export function looksBinary(head: Uint8Array): boolean {
  const limit = Math.min(head.length, BINARY_SNIFF_BYTES);

  for (let index = 0; index < limit; index += 1) {
    if (head[index] === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Largest upload, per file.
 *
 * This is **not** a disk quota: nothing stops anyone uploading a thousand
 * one-gigabyte files. It is a bound against the accident — the 60 GiB modpack
 * dropped in by mistake. The per-server disk limit applies on top and is the
 * one that says how much a server may hold; this only says how much may arrive
 * in a single request.
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
  mode: z.string().regex(/^[0-7]{3}$/, 'Three octal digits expected, 644 for instance.'),
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
  fetch: (uuid: string) => `/api/servers/${uuid}/files/fetch`,
} as const;

/**
 * Hosts the daemon will fetch a file from.
 *
 * An allowlist, not a validation. The panel hands the daemon a URL, so without
 * one this endpoint would be an open proxy running inside the operator's
 * network: point it at `http://169.254.169.254/` and a cloud instance hands
 * back its credentials, at `http://127.0.0.1:5432` and it probes the database.
 *
 * Frozen in the contract rather than made a setting, for the same reason the
 * update check's repository is: an administrator who could add a host would be
 * turning a catalogue into a request the daemon makes on their behalf, from
 * inside.
 */
export const ALLOWED_FETCH_HOSTS = ['cdn.modrinth.com'] as const;

export const fetchRemoteFileRequestSchema = z.object({
  url: z.string().url(),
  /** Destination folder, relative to the volume root. */
  directory: z.string().min(1).default('/'),
  /** A name, not a path — validated exactly as an upload's is. */
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) => !/[/\\]/.test(value) && value !== '.' && value !== '..',
      'A file name may contain neither a path separator nor "..".',
    ),
  /**
   * SHA-512 the catalogue published for this file.
   *
   * Checked after the download, and the file removed when it does not match.
   * The point is not the network — that is TLS's job — but the catalogue: a
   * project whose files were replaced upstream should not install silently.
   */
  sha512: z
    .string()
    .regex(/^[0-9a-f]{128}$/, 'A SHA-512 is 128 hexadecimal characters.')
    .optional(),
});

export type FetchRemoteFileRequest = z.infer<typeof fetchRemoteFileRequestSchema>;
