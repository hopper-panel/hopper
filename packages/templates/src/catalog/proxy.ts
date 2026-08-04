import { JAVA_IMAGES, TEMPLATE_GROUPS, type TemplateDefinition } from '../definition.js';

/**
 * Proxies : les serveurs qui n'hébergent pas de monde, mais aiguillent les
 * joueurs vers d'autres serveurs.
 *
 * Deux différences importantes avec un serveur de jeu :
 *  • ils n'ont pas de `server.properties` — leur configuration vit dans
 *    `velocity.toml` ou `config.yml`, écrite au premier démarrage ;
 *  • le port qu'ils écoutent est déclaré dans cette configuration, que Hopper
 *    réécrit avant chaque démarrage.
 */

const PREAMBLE = [
  '#!/bin/bash',
  'set -euo pipefail',
  '',
  'apt-get update',
  'apt-get install -y --no-install-recommends curl jq ca-certificates',
  '',
  'mkdir -p /mnt/server',
  'cd /mnt/server',
  '',
].join('\n');

const JARFILE_VARIABLE = {
  name: 'Fichier du proxy',
  description: 'Nom du fichier .jar lancé au démarrage. Il doit se trouver à la racine du serveur.',
  envVariable: 'SERVER_JARFILE',
  defaultValue: 'proxy.jar',
  userViewable: true,
  /** Même contrainte que pour un serveur Java : un nom de fichier, jamais un chemin. */
  userEditable: true,
  // `String.raw` : voir la même règle dans `catalog/java.ts`.
  rules: String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`,
};

export const velocity: TemplateDefinition = {
  key: 'velocity',
  group: TEMPLATE_GROUPS.PROXY,
  name: 'Velocity',
  description: 'Proxy moderne, rapide et activement maintenu. Recommandé pour tout nouveau réseau.',
  author: 'Hopper',
  // Velocity exige Java 17 au minimum, et Java 21 pour les versions récentes :
  // Java 8 et 11 sont volontairement absents de la liste.
  dockerImages: JAVA_IMAGES.filter((option) => ['Java 21', 'Java 17'].includes(option.name)),
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  stopCommand: 'command:end',
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [
    {
      file: 'velocity.toml',
      parser: 'file',
      replacements: [{ match: 'bind', replaceWith: '0.0.0.0:{{server.build.default.port}}' }],
    },
  ],
  // `forwarding.secret` authentifie le proxy auprès des serveurs : le laisser
  // lisible permettrait à n'importe quel sous-utilisateur d'usurper le proxy et
  // de se connecter avec le pseudo de son choix.
  fileDenylist: ['forwarding.secret'],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'PROJECT="https://fill.papermc.io/v3/projects/velocity"',
    '',
    'if [ "${VELOCITY_VERSION}" = "latest" ]; then',
    '  # Les versions sont groupées par famille ; on prend la plus récente qui',
    '  # ne soit pas un instantané de développement.',
    '  VERSION=$(curl -sSL --fail "${PROJECT}" \\',
    '    | jq -r "[.versions[][] | select(test(\\"SNAPSHOT\\") | not)] | .[0]")',
    'else',
    '  VERSION="${VELOCITY_VERSION}"',
    'fi',
    '',
    'if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then',
    '  echo "Impossible de déterminer une version de Velocity." >&2',
    '  exit 1',
    'fi',
    '',
    'echo "Installation de Velocity ${VERSION}"',
    '',
    'URL=$(curl -sSL --fail "${PROJECT}/versions/${VERSION}/builds" \\',
    '  | jq -r \'[.[] | select(.channel == "STABLE")] | max_by(.id) | .downloads["server:default"].url\')',
    '',
    'if [ -z "${URL}" ] || [ "${URL}" = "null" ]; then',
    '  echo "Aucune build stable de Velocity ${VERSION}." >&2',
    '  exit 1',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" "${URL}"',
  ].join('\n'),
  variables: [
    {
      name: 'Version de Velocity',
      description: 'Version à installer, ou « latest ».',
      envVariable: 'VELOCITY_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:20',
    },
    JARFILE_VARIABLE,
  ],
};

export const bungeecord: TemplateDefinition = {
  key: 'bungeecord',
  group: TEMPLATE_GROUPS.PROXY,
  name: 'BungeeCord',
  description:
    'Proxy historique de SpigotMC. Toujours maintenu, mais Velocity lui est préférable pour un nouveau réseau : meilleures performances et écosystème de plugins plus actif.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  stopCommand: 'command:end',
  startupDetection: 'Listening on ',
  configFiles: [
    {
      file: 'config.yml',
      parser: 'yaml',
      replacements: [
        { match: 'listeners[0].host', replaceWith: '0.0.0.0:{{server.build.default.port}}' },
      ],
    },
  ],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    '# BungeeCord ne publie pas d’API de version : son intégration continue',
    '# expose directement le dernier artefact réussi.',
    'BASE="https://ci.md-5.net/job/BungeeCord"',
    '',
    'if [ "${BUNGEE_BUILD}" = "latest" ]; then',
    '  BUILD="lastSuccessfulBuild"',
    'else',
    '  BUILD="${BUNGEE_BUILD}"',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "${BASE}/${BUILD}/artifact/bootstrap/target/BungeeCord.jar"',
  ].join('\n'),
  variables: [
    {
      name: 'Build BungeeCord',
      description: 'Numéro de build, ou « latest » pour la dernière réussie.',
      envVariable: 'BUNGEE_BUILD',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:20',
    },
    JARFILE_VARIABLE,
  ],
};

export const PROXY_TEMPLATES: TemplateDefinition[] = [velocity, bungeecord];
