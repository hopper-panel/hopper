import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { daemonConfigSchema, type DaemonConfig } from './schema.js';

export const DEFAULT_CONFIG_PATH =
  process.platform === 'win32' ? 'daemon.yml' : '/etc/hopper/daemon.yml';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Paths resolved once and for all, to avoid recomputing them everywhere.
 *
 * Declared as a type alias and not an `interface`: only aliases receive an
 * implicit index signature, which `Object.values` needs in order to infer
 * `string[]` rather than `any[]`.
 */
export type ResolvedPaths = {
  root: string;
  data: string;
  backups: string;
  tmp: string;
};

export interface LoadedConfig {
  config: DaemonConfig;
  paths: ResolvedPaths;
  sourcePath: string;
}

export function resolveConfigPath(explicit?: string): string {
  const candidate = explicit ?? process.env.HOPPER_DAEMON_CONFIG ?? DEFAULT_CONFIG_PATH;
  return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

/**
 * Refuses to start if the configuration file is readable by other users. It
 * holds the node secret and the JWT signing key: a file in 0644 on a shared
 * host hands over control of every server.
 *
 * The check is skipped on Windows, where the POSIX bits Node reports do not
 * reflect the real ACLs. The daemon only runs there in development.
 */
export async function assertConfigFilePermissions(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  const stats = await stat(path);
  const mode = stats.mode & 0o777;

  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `The configuration file ${path} is readable by other users (mode ${mode.toString(8).padStart(4, '0')}).`,
      `Corrigez avec : chmod 600 ${path}`,
    );
  }
}

function resolvePaths(config: DaemonConfig): ResolvedPaths {
  const root = resolve(config.system.rootDirectory);

  return {
    root,
    data: config.system.dataDirectory
      ? resolve(config.system.dataDirectory)
      : join(root, 'volumes'),
    backups: config.system.backupDirectory
      ? resolve(config.system.backupDirectory)
      : join(root, 'backups'),
    tmp: config.system.tmpDirectory ? resolve(config.system.tmpDirectory) : join(root, 'tmp'),
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
    .join('\n');
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const sourcePath = resolveConfigPath(explicitPath);

  try {
    await access(sourcePath, fsConstants.R_OK);
  } catch {
    throw new ConfigError(
      `Fichier de configuration introuvable ou illisible : ${sourcePath}`,
      'Set HOPPER_DAEMON_CONFIG or pass --config, and check that the daemon user can read the file.',
    );
  }

  await assertConfigFilePermissions(sourcePath);

  const raw = await readFile(sourcePath, 'utf8');

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ConfigError(
      `YAML invalide dans ${sourcePath} : ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = daemonConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Configuration invalide dans ${sourcePath} :\n${formatIssues(result.error)}`,
    );
  }

  return { config: result.data, paths: resolvePaths(result.data), sourcePath };
}
