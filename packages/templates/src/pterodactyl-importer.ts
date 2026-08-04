import { z } from 'zod';
import {
  templateDefinitionSchema,
  type DockerImageOption,
  type TemplateDefinition,
  type TemplateVariableDefinition,
} from './definition.js';

/**
 * Conversion d'un « egg » Pterodactyl vers un template Hopper.
 *
 * L'intérêt est pratique : des centaines d'eggs existent, maintenus par la
 * communauté, pour des jeux et des modpacks que Hopper ne livrera jamais
 * lui-même. Les reprendre à la main serait absurde.
 *
 * Le format des eggs a beaucoup varié. Cet importeur accepte les révisions
 * PTDL_v1 et PTDL_v2, et tolère les champs absents plutôt que d'exiger un
 * fichier parfait : un egg incomplet doit produire un template utilisable
 * qu'un administrateur corrigera, pas une erreur qui le renvoie à son éditeur.
 */

/** Schéma tolérant : tout ce qui n'est pas indispensable est optionnel. */
const eggSchema = z.object({
  _comment: z.string().optional(),
  meta: z.object({ version: z.string().optional() }).optional(),
  name: z.string().min(1),
  author: z.string().optional(),
  description: z.string().optional(),
  uuid: z.string().optional(),

  /** PTDL_v2 : objet { "Java 21": "image" }. PTDL_v1 : tableau de chaînes. */
  docker_images: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional(),
  /** PTDL_v1 : une seule image. */
  image: z.string().optional(),

  startup: z.string().optional(),

  config: z
    .object({
      files: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      startup: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
      stop: z.string().optional(),
      logs: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    })
    .optional(),

  scripts: z
    .object({
      installation: z
        .object({
          script: z.string().optional(),
          container: z.string().optional(),
          entrypoint: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  variables: z
    .array(
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        env_variable: z.string().min(1),
        default_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        user_viewable: z.union([z.boolean(), z.number()]).optional(),
        user_editable: z.union([z.boolean(), z.number()]).optional(),
        rules: z.string().optional(),
      }),
    )
    .optional(),
});

export type PterodactylEgg = z.infer<typeof eggSchema>;

export class EggImportError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'EggImportError';
  }
}

export interface EggImportResult {
  template: TemplateDefinition;
  /**
   * Points nécessitant une relecture humaine.
   *
   * Un egg importé n'est presque jamais utilisable tel quel : les images
   * Docker pointent vers celles de Pterodactyl, et les commandes d'arrêt
   * exotiques ne se traduisent pas toujours. Les signaler vaut mieux que de
   * laisser l'administrateur découvrir le problème au premier démarrage.
   */
  warnings: string[];
}

/** Pterodactyl écrit tantôt des booléens, tantôt 0/1. */
function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/**
 * Normalise les images Docker.
 *
 * Un objet JSON perdrait son ordre en base : on produit un tableau, en
 * conservant l'ordre de déclaration de l'egg, qui reflète l'intention de son
 * auteur (la première est celle qu'il recommande).
 */
function convertImages(egg: PterodactylEgg, warnings: string[]): DockerImageOption[] {
  const images: DockerImageOption[] = [];

  if (Array.isArray(egg.docker_images)) {
    egg.docker_images.forEach((image) => images.push({ name: image, image }));
  } else if (egg.docker_images && typeof egg.docker_images === 'object') {
    Object.entries(egg.docker_images).forEach(([name, image]) => images.push({ name, image }));
  }

  if (images.length === 0 && egg.image) {
    images.push({ name: egg.image, image: egg.image });
  }

  if (images.length === 0) {
    throw new EggImportError('Cet egg ne déclare aucune image Docker.');
  }

  const foreign = images.filter((option) => !option.image.startsWith('ghcr.io/hopper-panel/'));

  if (foreign.length > 0) {
    warnings.push(
      `Les images de cet egg proviennent d'ailleurs (${foreign[0]!.image}). Elles fonctionneront, mais ne bénéficient pas du durcissement des images Hopper : vérifiez qu'elles exécutent un utilisateur non root d'UID 988.`,
    );
  }

  return images;
}

/**
 * Traduit la commande d'arrêt.
 *
 * Pterodactyl accepte une commande brute (`stop`) ou un signal préfixé
 * (`^C` pour SIGINT dans les eggs anciens).
 */
function convertStop(raw: string | undefined, warnings: string[]): string {
  const value = raw?.trim();

  if (!value) {
    warnings.push(
      "Aucune commande d'arrêt : le serveur recevra SIGTERM. Si le jeu ne sauvegarde pas à ce signal, précisez sa commande d'arrêt.",
    );
    return 'signal:SIGTERM';
  }

  if (value === '^C' || value.toUpperCase() === 'SIGINT') {
    return 'signal:SIGINT';
  }

  if (value.toUpperCase() === 'SIGTERM') {
    return 'signal:SIGTERM';
  }

  if (value.toUpperCase() === 'SIGKILL') {
    warnings.push(
      "L'egg demande un arrêt par SIGKILL, qui coupe le processus sans sauvegarde. Une commande d'arrêt propre est préférable.",
    );
    return 'signal:SIGKILL';
  }

  return `command:${value}`;
}

/** Le bloc `config` d'un egg est tantôt un objet, tantôt une chaîne JSON. */
function parseJsonBlock(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Extrait la ligne de détection de démarrage.
 *
 * Pterodactyl la stocke comme une sous-chaîne à chercher, pas comme une
 * expression régulière. On l'échappe donc avant de la transmettre à Hopper, qui
 * la compile : un egg contenant `Done (` produirait sinon une regex invalide,
 * et le serveur ne passerait jamais « en ligne ».
 */
function convertStartupDetection(raw: unknown, warnings: string[]): string | undefined {
  const block = parseJsonBlock(raw);
  const done = block.done;

  const value = Array.isArray(done)
    ? typeof done[0] === 'string'
      ? done[0]
      : undefined
    : typeof done === 'string'
      ? done
      : undefined;

  if (!value || value.trim() === '') {
    warnings.push(
      "Aucun marqueur de démarrage : le serveur sera considéré « en ligne » dès que son conteneur tourne, sans attendre qu'il accepte les connexions.",
    );
    return undefined;
  }

  if (Array.isArray(done) && done.length > 1) {
    warnings.push(
      `L'egg déclare plusieurs marqueurs de démarrage ; seul le premier (« ${value} ») est repris.`,
    );
  }

  return escapeRegExp(value);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertVariables(egg: PterodactylEgg, warnings: string[]): TemplateVariableDefinition[] {
  const variables: TemplateVariableDefinition[] = [];

  for (const variable of egg.variables ?? []) {
    // Un nom non conforme à POSIX ferait échouer l'`export` du script
    // d'installation, avec un message que personne ne relie à l'egg.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.env_variable)) {
      warnings.push(
        `Variable « ${variable.env_variable} » ignorée : son nom n'est pas un identifiant d'environnement valide.`,
      );
      continue;
    }

    variables.push({
      name: variable.name ?? variable.env_variable,
      description: variable.description ?? '',
      envVariable: variable.env_variable,
      defaultValue: variable.default_value == null ? '' : String(variable.default_value),
      userViewable: toBoolean(variable.user_viewable, true),
      userEditable: toBoolean(variable.user_editable, false),
      rules: variable.rules ?? 'nullable|string',
    });
  }

  return variables;
}

export interface ImportOptions {
  /** Groupe d'accueil du template importé. */
  group: string;
  /** Clé du template. Dérivée du nom de l'egg si absente. */
  key?: string;
}

export function importPterodactylEgg(raw: unknown, options: ImportOptions): EggImportResult {
  const parsed = eggSchema.safeParse(raw);

  if (!parsed.success) {
    throw new EggImportError(
      'Ce fichier ne ressemble pas à un egg Pterodactyl.',
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`,
      ),
    );
  }

  const egg = parsed.data;
  const warnings: string[] = [];

  const version = egg.meta?.version;
  if (version && version !== 'PTDL_v1' && version !== 'PTDL_v2') {
    warnings.push(
      `Révision d'egg inconnue (${version}). L'import a été tenté, mais relisez le résultat.`,
    );
  }

  const installation = egg.scripts?.installation;

  if (!installation?.script || installation.script.trim() === '') {
    throw new EggImportError("Cet egg ne contient aucun script d'installation.");
  }

  if (!egg.startup || egg.startup.trim() === '') {
    throw new EggImportError('Cet egg ne déclare aucune commande de démarrage.');
  }

  const configFiles = parseJsonBlock(egg.config?.files);
  if (Object.keys(configFiles).length > 0) {
    warnings.push(
      "Les fichiers de configuration de cet egg n'ont pas été repris : leur format diffère de celui de Hopper. Vérifiez que le port d'écoute est bien appliqué au démarrage.",
    );
  }

  const template = templateDefinitionSchema.parse({
    key: options.key ?? slugify(egg.name),
    group: options.group,
    name: egg.name,
    description: egg.description ?? '',
    author: egg.author ?? 'Importé de Pterodactyl',
    dockerImages: convertImages(egg, warnings),
    startup: egg.startup.trim(),
    stopCommand: convertStop(egg.config?.stop, warnings),
    startupDetection: convertStartupDetection(egg.config?.startup, warnings),
    configFiles: [],
    fileDenylist: [],
    installContainer: installation.container ?? 'debian:bookworm-slim',
    installEntrypoint: installation.entrypoint ?? '/bin/bash',
    // Pterodactyl monte le volume sur /mnt/server, comme Hopper : les scripts
    // sont directement compatibles.
    installScript: installation.script,
    variables: convertVariables(egg, warnings),
    importedFromEgg: egg.uuid,
  });

  return { template, warnings };
}

/** Transforme « Paper (1.8) » en « paper-1-8 ». */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    // Retire les diacritiques laissés par la décomposition : « é » devient
    // « e » plutôt que d'être supprimé entièrement.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  // Un nom entièrement composé de caractères non latins — du cyrillique, des
  // idéogrammes — se réduirait à une chaîne vide, que le schéma refuse. On
  // dérive alors une clé du nom lui-même : deux imports du même egg doivent
  // produire la même clé, sans quoi l'upsert créerait un doublon à chaque fois.
  return slug === '' ? `egg-${fingerprint(value)}` : slug;
}

/** Empreinte courte et stable d'une chaîne, en base 36. */
function fingerprint(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}
