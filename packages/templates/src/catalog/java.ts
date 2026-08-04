import {
  BUKKIT_STARTUP_DETECTION,
  JAVA_IMAGES,
  SERVER_PROPERTIES_CONFIG,
  TEMPLATE_GROUPS,
  type TemplateDefinition,
} from '../definition.js';

/**
 * Templates Minecraft: Java Edition.
 *
 * Chaque script d'installation est écrit contre l'API réellement en service au
 * moment de sa rédaction, et vérifie ce qu'il télécharge. Un `curl` sans
 * `--fail` sur une API qui répond « 200 » avec un corps d'erreur — le cas de
 * l'API v2 de PaperMC depuis son arrêt — produit un fichier de zéro octet et
 * un serveur qui échoue au démarrage sans explication.
 */

/** Préambule commun : mode strict, outils, répertoire de travail. */
const PREAMBLE = [
  '#!/bin/bash',
  '# set -e : la moindre commande en échec arrête l’installation, plutôt que de',
  '# laisser croire au succès avec un volume à moitié rempli.',
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
  '# Sans ce fichier, le serveur s’arrête au premier démarrage.',
  'echo "eula=true" > eula.txt',
  '',
].join('\n');

const MINECRAFT_VERSION_VARIABLE = {
  name: 'Version de Minecraft',
  description: 'Version à installer, par exemple 1.21.4.',
  envVariable: 'MINECRAFT_VERSION',
  defaultValue: '1.21.4',
  userViewable: true,
  userEditable: true,
  rules: 'required|string|max:20',
};

const JARFILE_VARIABLE = {
  name: 'Fichier du serveur',
  description: 'Nom du fichier .jar lancé au démarrage. Il doit se trouver à la racine du serveur.',
  envVariable: 'SERVER_JARFILE',
  defaultValue: 'server.jar',
  userViewable: true,
  /**
   * Modifiable, mais étroitement contraint.
   *
   * Cette valeur entre dans `java -jar {{SERVER_JARFILE}}`. Le laisser libre ne
   * donne toutefois rien de plus que ce dont l'utilisateur dispose déjà : il
   * peut déposer un fichier par le gestionnaire ou en SFTP, et un greffon
   * s'exécute de toute façon dans la JVM du serveur. Le conteneur reste la
   * frontière — capabilities abandonnées, utilisateur non privilégié, aucun
   * accès au socket Docker.
   *
   * L'expression impose en revanche un **nom de fichier**, jamais un chemin :
   * ni barre oblique, ni `..`, et l'extension `.jar` exigée. Cela empêche de
   * désigner un fichier ailleurs dans le volume — un `.jar` déposé dans
   * `plugins/` ne serait pas lancé par erreur — et écarte les valeurs qui ne
   * pourraient de toute façon rien exécuter.
   */
  userEditable: true,
  // `String.raw` : dans une chaîne ordinaire, `\.` est avalé par l'échappement
  // et le point redevient « n'importe quel caractère » — `serveurXjar`
  // passerait alors la règle.
  rules: String.raw`required|string|max:100|regex:/^[A-Za-z0-9._-]+\.jar$/`,
};

const JAVA_STARTUP =
  'java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}} nogui';

export const paper: TemplateDefinition = {
  key: 'paper',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Paper',
  description:
    'Fork de Spigot largement optimisé, compatible avec les plugins Bukkit et Spigot. Le choix par défaut pour un serveur à plugins.',
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
    '# API « fill » v3. La v2 a été arrêtée en 2025 : elle répond désormais',
    '# {"ok":false,"error":"sunset"} avec un code HTTP 200, ce qui produirait un',
    '# .jar de zéro octet sans que curl ne signale d’erreur.',
    'BUILDS="https://fill.papermc.io/v3/projects/paper/versions/${MINECRAFT_VERSION}/builds"',
    '',
    '# max_by(.id) et non last : l’API renvoie les builds les plus récentes en',
    '# premier, et « last » installerait donc la plus ancienne.',
    'URL=$(curl -sSL --fail "${BUILDS}" \\',
    '  | jq -r \'[.[] | select(.channel == "STABLE")] | max_by(.id) | .downloads["server:default"].url\')',
    '',
    'if [ -z "${URL}" ] || [ "${URL}" = "null" ]; then',
    '  echo "Aucune build stable de Paper pour Minecraft ${MINECRAFT_VERSION}." >&2',
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
    'Fork de Paper ajoutant de nombreux réglages de gameplay. Compatible avec les plugins Paper.',
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
    '  echo "Purpur ne publie pas de build pour Minecraft ${MINECRAFT_VERSION}." >&2',
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
    'Serveur officiel de Mojang, sans modification. Aucun plugin ni mod ne peut y être installé.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  startup: JAVA_STARTUP,
  stopCommand: 'command:stop',
  // Le serveur vanilla n'émet pas la ligne de Bukkit : c'est « Done (x.xxxs)! »
  // qui marque la fin du chargement.
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    PREAMBLE,
    'MANIFEST="https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"',
    '',
    '# « latest » suit la dernière version publiée, ce qui évite d’avoir à',
    '# modifier le template à chaque sortie de Mojang.',
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
    '  echo "Version Minecraft inconnue : ${VERSION}" >&2',
    '  exit 1',
    'fi',
    '',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "$(curl -sSL --fail "${META}" | jq -r ".downloads.server.url")"',
    EULA,
  ].join('\n'),
  variables: [
    { ...MINECRAFT_VERSION_VARIABLE, description: 'Version à installer, ou « latest ».' },
    JARFILE_VARIABLE,
  ],
};

export const fabric: TemplateDefinition = {
  key: 'fabric',
  group: TEMPLATE_GROUPS.JAVA,
  name: 'Fabric',
  description:
    'Chargeur de mods léger et rapide à suivre les nouvelles versions de Minecraft. Incompatible avec les plugins Bukkit.',
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
    '  echo "Fabric ne publie pas de loader stable pour Minecraft ${MINECRAFT_VERSION}." >&2',
    '  exit 1',
    'fi',
    '',
    '# Le « server jar » de Fabric est un lanceur autonome : il télécharge le',
    '# reste au premier démarrage, ce qui évite de dépendre d’un installeur',
    '# interactif.',
    'curl -sSL --fail -o "${SERVER_JARFILE}" \\',
    '  "https://meta.fabricmc.net/v2/versions/loader/${MINECRAFT_VERSION}/${LOADER}/${INSTALLER}/server/jar"',
    EULA,
  ].join('\n'),
  variables: [
    MINECRAFT_VERSION_VARIABLE,
    {
      name: 'Version du loader Fabric',
      description: 'Version du chargeur, ou « latest » pour la dernière stable.',
      envVariable: 'FABRIC_LOADER_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:20',
    },
    {
      name: "Version de l'installeur Fabric",
      description: 'Version de l’installeur, ou « latest ».',
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
    'Chargeur de mods issu de Forge, adopté par la majorité des modpacks récents. Incompatible avec les plugins Bukkit.',
  author: 'Hopper',
  dockerImages: JAVA_IMAGES,
  // NeoForge ne se lance pas avec `-jar` : son installeur produit un fichier
  // d'arguments qui construit le classpath. Ce fichier vit normalement sous
  // `libraries/net/neoforged/neoforge/<version>/unix_args.txt`, chemin qui
  // change à chaque version — impossible à écrire dans une commande de
  // démarrage figée. L'installation en dépose donc une copie à un emplacement
  // stable.
  startup: 'java @user_jvm_args.txt @hopper_args.txt nogui',
  stopCommand: 'command:stop',
  startupDetection: 'Done \\([0-9.]+s\\)!',
  configFiles: [SERVER_PROPERTIES_CONFIG],
  fileDenylist: [],
  // L'installeur NeoForge est lui-même un programme Java : le conteneur
  // d'installation doit donc embarquer un JDK.
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
    '  # Les versions bêta sont écartées : elles cassent régulièrement les mods.',
    '  VERSION=$(curl -sSL --fail "${VERSIONS}" \\',
    '    | jq -r \'[.versions[] | select(test("-beta$") | not)] | last\')',
    'else',
    '  VERSION="${NEOFORGE_VERSION}"',
    'fi',
    '',
    'if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then',
    '  echo "Impossible de déterminer une version de NeoForge." >&2',
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
    '# Copie du fichier d’arguments à un emplacement que la commande de démarrage',
    '# peut nommer sans connaître la version installée. Les chemins qu’il contient',
    '# sont relatifs au répertoire de travail, la copie reste donc valide.',
    'ARGS=$(find libraries/net/neoforged/neoforge -name unix_args.txt | head -n 1)',
    '',
    'if [ -z "${ARGS}" ]; then',
    '  echo "L’installeur NeoForge n’a pas produit de fichier d’arguments." >&2',
    '  exit 1',
    'fi',
    '',
    'cp "${ARGS}" hopper_args.txt',
    '',
    '# Lu par la commande de démarrage : sans lui, le serveur démarrerait sans',
    '# limite mémoire, quelle que soit celle fixée dans le panel.',
    'echo "-Xms128M -Xmx${SERVER_MEMORY}M" > user_jvm_args.txt',
    '',
    'echo "eula=true" > eula.txt',
  ].join('\n'),
  variables: [
    {
      name: 'Version de NeoForge',
      description: 'Version exacte, ou « latest » pour la dernière stable.',
      envVariable: 'NEOFORGE_VERSION',
      defaultValue: 'latest',
      userViewable: true,
      userEditable: true,
      rules: 'required|string|max:30',
    },
  ],
};

export const JAVA_TEMPLATES: TemplateDefinition[] = [paper, purpur, vanilla, fabric, neoforge];
