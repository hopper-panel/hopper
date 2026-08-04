import {
  BUKKIT_STARTUP_DETECTION,
  JAVA_IMAGES,
  SERVER_PROPERTIES_CONFIG,
  TEMPLATE_GROUPS,
  type TemplateDefinition,
} from '../definition.js';

/**
 * Minecraft: Java Edition templates.
 *
 * Each install script is written against the API actually in service when it
 * was written, and checks what it downloads. A `curl` without `--fail` against
 * an API that answers "200" with an error body — the case of PaperMC's v2 API
 * since it was retired — produces a zero-byte file and a server that fails to
 * start with no explanation.
 */

/** Shared preamble: strict mode, tools, working directory. */
const PREAMBLE = [
  '#!/bin/bash',
  '# set -e: the slightest failing command stops the installation, rather than',
  '# suggesting success with a half-filled volume.',
  'set -euo pipefail',
  '',
  'apt-get update',
  'apt-get install -y --no-install-recommends curl jq ca-certificates',
  '',
  'mkdir -p /mnt/server',
  'cd /mnt/server',
  '',
].join('\n');

const EULA = [
  '',
  '# Without this file, the server stops on its first start.',
  'echo "eula=true" > eula.txt',
  '',
].join('\n');

const MINECRAFT_VERSION_VARIABLE = {
  name: 'Minecraft version',
  description: 'Version to install, for example 1.21.4.',
  envVariable: 'MINECRAFT_VERSION',
  defaultValue: '1.21.4',
  userViewable: true,
  userEditable: true,
  rules: 'required|string|max:20',
};

const JARFILE_VARIABLE = {
  name: 'Server file',
  description: 'Name of the .jar launched at startup. It has to sit at the root of the server.',
  envVariable: 'SERVER_JARFILE',
  defaultValue: 'server.jar',
  userViewable: true,
  /**
   * Editable, but tightly constrained.
   *
   * This value feeds `java -jar {{SERVER_JARFILE}}`. Leaving it free gives the
   * user nothing beyond what they already have, though: they can drop a file in
   * through the file manager or over SFTP, and a plugin runs inside the
   * server's JVM anyway. The container stays the boundary — capabilities
   * dropped, unprivileged user, no access to the Docker socket.
   *
   * The expression does impose a **file name**, never a path: no slash, no
   * `..`, and the `.jar` extension required. That stops it from naming a file
   * elsewhere in the volume — a `.jar` dropped in `plugins/` would not be
   * launched by mistake — and rules out values that could not run anything
   * anyway.
   */
  userEditable: true,
  // `String.raw`: in an ordinary string, `\.` is swallowed by the escaping and
  // the dot becomes "any character" again — `serverXjar` would then pass the
  // rule.
  rules: String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`,
};

const JAVA_STARTUP =
  'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}} nogui';

export const paper: TemplateDefinition = {
  key: 'paper',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Paper',
  description:
    'A heavily optimised fork of Spigot, compatible with Bukkit and Spigot plugins. The default choice for a plugin server.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: JAVA_STARTUP,
  stopCommand: 'command:stop',
  startupDetection: BUKKIT_STARTUP_DETECTION,
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    '# The "fill" v3 API. v2 was retired in 2025: it now answers',
    '# {"ok":false,"error":"sunset"} with HTTP 200, which would produce a',
    '# zero-byte .jar without curl reporting an error.',
    'BUILDS="https://fill.papermc.io/v3/projects/paper/versions/${MINECRAFT_VERSION}/builds"',
    '',
    '# max_by(.id) and not last: the API returns the most recent builds first,',
    '# so "last" would install the oldest one.',
    'URL=$(curl -sSL --fail "${BUILDS}" \\',
    '  | jq -r \'[.[] | select(.channel == "STABLE")] | max_by(.id) | .downloads["server:default"].url\')',
    '',
    'if [ -z "${URL}" ] || [ "${URL}" = "null" ]; then',
    '  echo "No stable Paper build for Minecraft ${MINECRAFT_VERSION}." >&2',
    '  exit 1',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" "${URL}"',
    EULA,
  ].join('\n'),
  variables: [MINECRAFT_VERSION_VARIABLE, JARFILE_VARIABLE],
};

export const purpur: TemplateDefinition = {
  key: 'purpur',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Purpur',
  description:
    'A fork of Paper adding many gameplay settings. Compatible with Paper plugins.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: JAVA_STARTUP,
  stopCommand: 'command:stop',
  startupDetection: BUKKIT_STARTUP_DETECTION,
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'BUILD=$(curl -sSL --fail "https://api.purpurmc.org/v2/purpur/${MINECRAFT_VERSION}" \\',
    '  | jq -r ".builds.latest")',
    '',
    'if [ -z "${BUILD}" ] || [ "${BUILD}" = "null" ]; then',
    '  echo "Purpur publishes no build for Minecraft ${MINECRAFT_VERSION}." >&2',
    '  exit 1',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "https://api.purpurmc.org/v2/purpur/${MINECRAFT_VERSION}/${BUILD}/download"',
    EULA,
  ].join('\n'),
  variables: [MINECRAFT_VERSION_VARIABLE, JARFILE_VARIABLE],
};

export const vanilla: TemplateDefinition = {
  key: 'vanilla',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Vanilla',
  description:
    "Mojang's official server, unmodified. No plugin or mod can be installed on it.",
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: JAVA_STARTUP,
  stopCommand: 'command:stop',
  // The vanilla server does not emit Bukkit's line: "Done (x.xxxs)!" is what
  // marks the end of loading.
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'MANIFEST="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"',
    '',
    '# "latest" follows the most recently published version, which saves',
    '# editing the template on every Mojang release.',
    'if [ "${MINECRAFT_VERSION}" = "latest" ]; then',
    '  VERSION=$(curl -sSL --fail "${MANIFEST}" | jq -r ".latest.release")',
    'else',
    '  VERSION="${MINECRAFT_VERSION}"',
    'fi',
    '',
    'META=$(curl -sSL --fail "${MANIFEST}" \\',
    '  | jq -r --arg v "${VERSION}" \'.versions[] | select(.id == $v) | .url\')',
    '',
    'if [ -z "${META}" ]; then',
    '  echo "Unknown Minecraft version: ${VERSION}" >&2',
    '  exit 1',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "$(curl -sSL --fail "${META}" | jq -r ".downloads.server.url")"',
    EULA,
  ].join('\n'),
  variables: [
    { ...MINECRAFT_VERSION_VARIABLE, description: 'Version to install, or "latest".' },
    JARFILE_VARIABLE,
  ],
};

export const fabric: TemplateDefinition = {
  key: 'fabric',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Fabric',
  description:
    'A light mod loader, quick to follow new Minecraft versions. Not compatible with Bukkit plugins.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: JAVA_STARTUP,
  stopCommand: 'command:stop',
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'LOADER="${FABRIC_LOADER_VERSION}"',
    'INSTALLER="${FABRIC_INSTALLER_VERSION}"',
    '',
    'if [ "${LOADER}" = "latest" ]; then',
    '  LOADER=$(curl -sSL --fail "https://meta.fabricmc.net/v2/versions/loader/${MINECRAFT_VERSION}" \\',
    '    | jq -r "[.[] | select(.loader.stable == true)] | .[0].loader.version")',
    'fi',
    '',
    'if [ "${INSTALLER}" = "latest" ]; then',
    '  INSTALLER=$(curl -sSL --fail "https://meta.fabricmc.net/v2/versions/installer" \\',
    '    | jq -r "[.[] | select(.stable == true)] | .[0].version")',
    'fi',
    '',
    'if [ -z "${LOADER}" ] || [ "${LOADER}" = "null" ]; then',
    '  echo "Fabric publishes no stable loader for Minecraft ${MINECRAFT_VERSION}." >&2',
    '  exit 1',
    'fi',
    '',
    '# Fabric\'s "server jar" is a standalone launcher: it downloads the rest',
    '# on the first start, which avoids depending on an interactive installer.',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "https://meta.fabricmc.net/v2/versions/loader/${MINECRAFT_VERSION}/${LOADER}/${INSTALLER}/server/jar"',
    EULA,
  ].join('\n'),
  variables: [
    MINECRAFT_VERSION_VARIABLE,
    {
      name: 'Fabric loader version',
      description: 'Loader version, or "latest" for the latest stable one.',
      envVariable: 'FABRIC_LOADER_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:20',
    },
    {
      name: 'Fabric installer version',
      description: 'Installer version, or "latest".',
      envVariable: 'FABRIC_INSTALLER_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:20',
    },
    JARFILE_VARIABLE,
  ],
};

export const neoforge: TemplateDefinition = {
  key: 'neoforge',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'NeoForge',
  description:
    'A mod loader descended from Forge, adopted by most recent modpacks. Not compatible with Bukkit plugins.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  // NeoForge does not launch with `-jar`: its installer produces an argument
  // file that builds the classpath. That file normally lives under
  // `libraries/net/neoforged/neoforge/<version>/unix_args.txt`, a path that
  // changes with every version — impossible to write into a frozen startup
  // command. The installation therefore drops a copy at a stable location.
  startup: 'java @user_jvm_args.txt @hopper_args.txt nogui',
  stopCommand: 'command:stop',
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  // The NeoForge installer is itself a Java program: the install container
  // therefore has to carry a JDK.
  installContainer: 'eclipse-temurin:21-jdk-noble',
  installEntrypoint: '/bin/bash',
  installScript: [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    'apt-get update',
    'apt-get install -y --no-install-recommends curl jq ca-certificates',
    '',
    'mkdir -p /mnt/server',
    'cd /mnt/server',
    '',
    'VERSIONS="https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"',
    '',
    'if [ "${NEOFORGE_VERSION}" = "latest" ]; then',
    '  # Beta versions are skipped: they regularly break mods.',
    '  VERSION=$(curl -sSL --fail "${VERSIONS}" \\',
    '    | jq -r \'[.versions[] | select(test("-beta$") | not)] | last\')',
    'else',
    '  VERSION="${NEOFORGE_VERSION}"',
    'fi',
    '',
    'if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then',
    '  echo "Could not determine a NeoForge version." >&2',
    '  exit 1',
    'fi',
    '',
    'echo "Installation de NeoForge ${VERSION}"',
    '',
    'curl -sSL --fail -o installer.jar \\',
    '  "https://maven.neoforged.net/releases/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-installer.jar"',
    '',
    'java -jar installer.jar --installServer',
    'rm -f installer.jar installer.jar.log',
    '',
    '# Copy of the argument file to a location the startup command can name',
    '# without knowing the installed version. The paths it contains are relative',
    '# to the working directory, so the copy stays valid.',
    'ARGS=$(find libraries/net/neoforged/neoforge -name unix_args.txt | head -n 1)',
    '',
    'if [ -z "${ARGS}" ]; then',
    '  echo "The NeoForge installer produced no argument file." >&2',
    '  exit 1',
    'fi',
    '',
    'cp "${ARGS}" hopper_args.txt',
    '',
    '# Read by the startup command: without it the server would start with no',
    '# memory limit, whatever the panel says.',
    'echo "-Xms128M -Xmx${SERVER_MEMORY}M" > user_jvm_args.txt',
    '',
    'echo "eula=true" > eula.txt',
  ].join('\n'),
  variables: [
    {
      name: 'NeoForge version',
      description: 'Exact version, or "latest" for the latest stable one.',
      envVariable: 'NEOFORGE_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:30',
    },
  ],
};

export const JAVA_TEMPLATES: TemplateDefinition[] = [paper, purpur, vanilla, fabric, neoforge];
