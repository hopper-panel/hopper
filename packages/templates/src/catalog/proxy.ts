import { JAVA_IMAGES, TEMPLATE_GROUPS, type TemplateDefinition } from '../definition.js';

/**
 * Proxies: the servers that host no world, but route players to other servers.
 *
 * Two important differences from a game server:
 *  • they have no `server.properties` — their configuration lives in
 *    `velocity.toml` or `config.yml`, written on the first start;
 *  • the port they listen on is declared in that configuration, which Hopper
 *    rewrites before every start.
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
  name: 'Proxy file',
  description: 'Name of the .jar launched at startup. It has to sit at the root of the server.',
  envVariable: 'SERVER_JARFILE',
  defaultValue: 'proxy.jar',
  userViewable: true,
  /** Same constraint as for a Java server: a file name, never a path. */
  userEditable: true,
  // `String.raw`: see the same rule in `catalog/java.ts`.
  rules: String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`,
};

export const velocity: TemplateDefinition = {
  key: 'velocity',
  group: TEMPLATE_GROUPS.PROXY,
  name: 'Velocity',
  description: 'A modern, fast, actively maintained proxy. Recommended for any new network.',
  author: 'Hopper',
  // Velocity needs Java 17 at least, and Java 21 for recent versions: Java 8
  // and 11 are deliberately absent from the list.
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
  // `forwarding.secret` authenticates the proxy to the servers: leaving it
  // readable would let any subuser impersonate the proxy and connect under the
  // username of their choice.
  fileDenylist: ['forwarding.secret'],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'PROJECT="https://fill.papermc.io/v3/projects/velocity"',
    '',
    'if [ "${VELOCITY_VERSION}" = "latest" ]; then',
    '  # Versions are grouped by family; take the most recent one that is not',
    '  # a development snapshot.',
    '  VERSION=$(curl -sSL --fail "${PROJECT}" \\',
    '    | jq -r "[.versions[][] | select(test(\\"SNAPSHOT\\") | not)] | .[0]")',
    'else',
    '  VERSION="${VELOCITY_VERSION}"',
    'fi',
    '',
    'if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then',
    '  echo "Could not determine a Velocity version." >&2',
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
      name: 'Velocity version',
      description: 'Version to install, or "latest".',
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
    "SpigotMC's long-standing proxy. Still maintained, but Velocity is preferable for a new network: better performance and a more active plugin ecosystem.",
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
    '# BungeeCord publishes no version API: its continuous integration exposes',
    '# the latest successful artefact directly.',
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
      name: 'BungeeCord build',
      description: 'Build number, or "latest" for the latest successful one.',
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
