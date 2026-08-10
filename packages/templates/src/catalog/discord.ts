import { TEMPLATE_GROUPS, type TemplateDefinition } from '../definition.js';

/**
 * Discord bots, in Python and in Node.
 *
 * The first templates in this catalogue that host **somebody else's code**
 * rather than a game, and that difference decides almost everything below.
 * There is no depot to download, no map to pick and no port to listen on: a bot
 * opens an outbound WebSocket to Discord and waits. What there is instead is a
 * dependency tree the operator wrote, which is the whole of the problem.
 *
 * Three constraints, each verified against this codebase rather than assumed,
 * and between them they explain the shape:
 *
 *  • **A startup command is argv, not a shell line.** `buildInvocation`
 *    tokenises the template and hands the tokens to Docker; there is no `sh
 *    -c`, so `pip install … && python bot.py` is not available and never was.
 *    Dependencies therefore install at *install* time, and adding one means
 *    reinstalling — the same shape the Steam templates have, for a different
 *    reason.
 *  • **The install container is thrown away.** Only `/mnt/server` survives it,
 *    so anything `pip` writes into the container's own `site-packages` is gone
 *    before the bot starts. The packages go into the volume and the runtime is
 *    pointed at them.
 *  • **The container runs as a numeric uid with no passwd entry**, so `$HOME`
 *    is whatever the image sets and `~/.local` is not somewhere to build on.
 *    `--target` and an explicit `PYTHONPATH` say where the packages are without
 *    depending on any of that.
 *
 * What these templates deliberately do **not** do is clone from git. It is the
 * obvious next feature and the one with the most ways to go wrong — private
 * repositories, credentials in a variable the file manager displays, a pull
 * that conflicts with edits made through SFTP — and none of it is needed to
 * host a bot you can upload. The install script says so rather than leaving the
 * operator to discover that an empty volume installs nothing.
 */

/** Where the install puts packages, seen from the install container. */
const DEPS_INSTALL_PATH = '/mnt/server/.python-deps';

/**
 * The same directory seen from the running bot.
 *
 * The volume is mounted at `/home/container` and that is also the working
 * directory, so these two strings are the same place through two mounts. Both
 * are written out rather than assembled, because the pair is a contract between
 * the install script and the runtime — the same reasoning the Source template
 * gives for spelling out `.steam/sdk32`.
 */
const DEPS_RUNTIME_PATH = '/home/container/.python-deps';

/**
 * The bot a new server starts with.
 *
 * Deliberately the smallest thing that is *correct*: it signs in, says so, and
 * stays online. No message handler, and that omission is the considered part —
 * reading message content is a privileged intent, off by default, and a
 * scaffold that used it would crash at the first start of every server whose
 * owner had not been through the developer portal. A bot that does nothing and
 * works beats a demonstration that fails, so the interesting half is a comment
 * saying exactly which switch to flip.
 *
 * The token is read from the environment. It is never written into this file,
 * which the file manager displays and every backup archive carries.
 */
const BOT_PY = [
  'import os',
  '',
  'import discord',
  '',
  '# Set on the Startup page. Never put the token in this file: the file',
  '# manager shows it and every backup carries it.',
  'TOKEN = os.environ["DISCORD_TOKEN"]',
  '',
  '# Default intents ask for nothing privileged, so this bot starts whatever',
  '# your application is configured for. To read what people type, turn on',
  '# "Message Content Intent" in the Discord developer portal and add:',
  '#',
  '#     intents.message_content = True',
  '#',
  '# without it, on_message receives empty content rather than an error.',
  'intents = discord.Intents.default()',
  'client = discord.Client(intents=intents)',
  '',
  '',
  '@client.event',
  'async def on_ready():',
  '    print(f"Signed in as {client.user}.")',
  '',
  '',
  'client.run(TOKEN)',
];

/**
 * The Node equivalent, and the same reasoning throughout.
 *
 * `GatewayIntentBits.Guilds` alone: enough to connect and to see the servers
 * the bot is in, and nothing that has to be enabled anywhere first.
 */
const BOT_JS = [
  "import { Client, GatewayIntentBits } from 'discord.js';",
  '',
  '// Set on the Startup page. Never put the token in this file: the file',
  '// manager shows it and every backup carries it.',
  'const token = process.env.DISCORD_TOKEN;',
  '',
  '// Guilds alone asks for nothing privileged. To read what people type, turn',
  '// on "Message Content Intent" in the Discord developer portal and add',
  '// GatewayIntentBits.MessageContent here.',
  'const client = new Client({ intents: [GatewayIntentBits.Guilds] });',
  '',
  "client.once('ready', () => {",
  '  console.log(`Signed in as ${client.user.tag}.`);',
  '});',
  '',
  'await client.login(token);',
];

const PACKAGE_JSON = [
  '{',
  '  "name": "discord-bot",',
  '  "private": true,',
  '  "type": "module",',
  '  "main": "index.js",',
  '  "dependencies": {',
  '    "discord.js": "^14.16.3"',
  '  }',
  '}',
];

const pythonInstallScript = [
  '#!/bin/bash',
  'set -euo pipefail',
  '',
  '# ---------------------------------------------------------------------',
  '# A bot to start from',
  '# ---------------------------------------------------------------------',
  '# Written only where there is nothing, file by file, which is the rule the',
  '# Source templates already follow for their server.cfg. A reinstall is how',
  '# a dependency gets added here, so this script runs against a volume full of',
  "# the operator's work every time - and a scaffold that wrote unconditionally",
  '# would throw their bot away at the moment they were being careful.',
  '#',
  '# It exists because the first version of this template did without it. A new',
  '# server came up on an empty volume, the startup command ran python against a',
  '# file nobody had written, and the console said: no such file or directory.',
  '# Correct, useless, and answered by a paragraph in an install log nobody had',
  '# a reason to open.',
  'cd /mnt/server',
  '',
  'if [ ! -f requirements.txt ]; then',
  "  cat > requirements.txt <<'REQ'",
  'discord.py>=2.4,<3',
  'REQ',
  '  echo "Wrote requirements.txt."',
  'fi',
  '',
  '# ${PY_FILE} rather than bot.py, because the startup command runs whatever',
  '# that variable names: seeding the other file would leave the same error',
  '# standing with something in the volume to make it puzzling. mkdir because',
  '# the variable admits src/main.py.',
  'PY_FILE="${PY_FILE:-bot.py}"',
  'mkdir -p "$(dirname "${PY_FILE}")"',
  '',
  'if [ ! -f "${PY_FILE}" ]; then',
  '  # A quoted heredoc: nothing in the body is expanded, so the token is read',
  '  # from the environment when the bot runs and is never written to disk.',
  '  cat > "${PY_FILE}" <<\'BOT\'',
  ...BOT_PY,
  'BOT',
  '  echo "Wrote ${PY_FILE}: a bot that signs in and stays online."',
  'fi',
  '',
  '# ---------------------------------------------------------------------',
  '# The dependencies',
  '# ---------------------------------------------------------------------',
  '# --target rather than a virtualenv or --user, and the reason is that this',
  '# container is about to be deleted. Only /mnt/server outlives it, so the',
  '# packages have to land there; a virtualenv would work too and would put a',
  "# python binary and a pile of symlinks in the operator's file manager for",
  '# no gain, since PYTHONPATH is one variable.',
  '#',
  '# --upgrade so that a changed requirements.txt actually changes what is',
  '# installed: without it pip leaves an already-present package alone, and a',
  '# reinstall run precisely to move a version would report success and move',
  '# nothing.',
  `mkdir -p ${DEPS_INSTALL_PATH}`,
  `pip install --no-cache-dir --upgrade --target ${DEPS_INSTALL_PATH} -r requirements.txt`,
  '',
  '# Compiled wheels are built for one Python minor version and one C library.',
  "# Both are the image's, so changing the image is not a free choice: the",
  '# packages here were built against this one, and a bot moved from 3.13 to',
  '# 3.12 needs a reinstall to rebuild them. Said out loud because the failure',
  '# is an ImportError at the first start with nothing pointing back here.',
  'echo ""',
  'echo "Dependencies installed into .python-deps."',
  'echo ""',
  'echo "They were built for this image\'s Python. If you change the image,"',
  'echo "reinstall as well - otherwise the first start fails on an import."',
  'echo ""',
  'echo "Set DISCORD_TOKEN on the Startup page; your bot reads it from the"',
  'echo "environment. Do not put it in a file the file manager displays."',
].join('\n');

const nodeInstallScript = [
  '#!/bin/bash',
  'set -euo pipefail',
  '',
  '# ---------------------------------------------------------------------',
  '# A bot to start from',
  '# ---------------------------------------------------------------------',
  '# Written only where there is nothing, file by file. A reinstall is how a',
  '# dependency gets added here, so this runs against a volume full of the',
  "# operator's work every time; a scaffold that wrote unconditionally would",
  '# throw their bot away at the moment they were being careful.',
  'cd /mnt/server',
  '',
  'if [ ! -f package.json ]; then',
  "  cat > package.json <<'PKG'",
  ...PACKAGE_JSON,
  'PKG',
  '  echo "Wrote package.json."',
  'fi',
  '',
  '# ${MAIN_FILE} rather than index.js: the startup command runs whatever that',
  '# variable names.',
  'MAIN_FILE="${MAIN_FILE:-index.js}"',
  'mkdir -p "$(dirname "${MAIN_FILE}")"',
  '',
  'if [ ! -f "${MAIN_FILE}" ]; then',
  '  # A quoted heredoc: the token is read from the environment when the bot',
  '  # runs and is never written to disk.',
  '  cat > "${MAIN_FILE}" <<\'BOT\'',
  ...BOT_JS,
  'BOT',
  '  echo "Wrote ${MAIN_FILE}: a bot that signs in and stays online."',
  'fi',
  '',
  '# ---------------------------------------------------------------------',
  '# The dependencies',
  '# ---------------------------------------------------------------------',
  '# node_modules needs no PYTHONPATH equivalent: Node resolves it by walking',
  '# up from the working directory, which is the volume, so installing it here',
  '# is enough for the runtime to find it.',
  '#',
  '# npm ci when there is a lockfile and npm install when there is not, which',
  '# is the difference between reproducing a dependency tree and resolving one.',
  '# ci also deletes node_modules first, so it repairs a half-installed tree -',
  '# and it refuses outright when the lockfile disagrees with package.json,',
  '# which is a better answer than quietly installing something else.',
  '#',
  '# --omit=dev because a bot in production has no use for its test runner, and',
  '# because every dependency not installed is one that cannot break the start.',
  'if [ -f package-lock.json ]; then',
  '  npm ci --omit=dev',
  'else',
  '  echo "No package-lock.json: resolving versions rather than reproducing"',
  '  echo "them. Commit the lockfile if you want the same tree every time."',
  '  npm install --omit=dev',
  'fi',
  '',
  'echo ""',
  'echo "Dependencies installed into node_modules."',
  'echo ""',
  'echo "Set DISCORD_TOKEN on the Startup page; your bot reads it from the"',
  'echo "environment. Do not put it in a file the file manager displays."',
].join('\n');

/**
 * The variable every bot here needs, and the one thing this catalogue can do
 * about secret handling.
 *
 * It is an environment variable rather than a line in a config file, and that
 * is the point: a token in `config.json` sits in the file manager, in every
 * backup archive and in anything the operator shares a screenshot of. In the
 * environment it is still readable by whoever can open the Startup page — the
 * panel has nowhere to keep a value out of sight yet, and none of these
 * templates pretends otherwise — but it is not in the volume.
 *
 * No default, and `required` so that a server cannot be created without one: a
 * bot started with an empty token exits on its first API call with an
 * authentication error that reads like a Discord outage.
 */
const discordTokenVariable = {
  name: 'Bot token',
  description:
    'From the Discord developer portal, under Bot. Your code reads it from the DISCORD_TOKEN environment variable - never commit it to the files in this volume.',
  envVariable: 'DISCORD_TOKEN',
  defaultValue: '',
  userViewable: true,
  userEditable: true,
  rules: 'required|string',
};

export const discordBotPython: TemplateDefinition = {
  key: 'discord-bot-python',
  group: TEMPLATE_GROUPS.DISCORD,
  name: 'Discord bot (Python)',
  description:
    'Runs a Python Discord bot you upload yourself - discord.py, Pycord, Hikari, anything that starts from one file. Dependencies come from requirements.txt and are installed by Reinstall, which is also how you update them. No git clone: upload through the file manager or SFTP.',
  author: 'Hopper',

  /**
   * The image decides the Python, and the Python decides the wheels in the
   * volume. First is the default; an existing server keeps the one it was
   * created with, which is what makes a version change a deliberate act
   * followed by a reinstall rather than something that happens on its own.
   */
  dockerImages: [
    { name: 'Python 3.13', image: 'python:3.13-slim' },
    { name: 'Python 3.12', image: 'python:3.12-slim' },
    { name: 'Python 3.11', image: 'python:3.11-slim' },
  ],

  /**
   * `-u`, and it is not decoration.
   *
   * CPython buffers stdout in 8 KiB blocks whenever it is not a terminal, and
   * the console here is a pipe. Without this flag a bot's `print()` output sits
   * in that buffer — so a bot that starts, logs "ready" and then idles shows an
   * empty console for as long as it takes to produce eight kilobytes, which for
   * most bots is never. The operator sees a server that is running and silent
   * and has no way to tell it from one that hung.
   */
  startup: 'python -u {{PY_FILE}}',

  /**
   * SIGINT rather than SIGTERM, which is the opposite of most templates here.
   *
   * A bare `python bot.py` installs no signal handler, and the two signals then
   * differ: SIGTERM kills the interpreter where it stands, while SIGINT raises
   * `KeyboardInterrupt` up through the running code — so `finally` blocks run,
   * `async with` bodies unwind, and discord.py's own `run()` catches it and
   * closes the gateway connection rather than dropping it. A bot that saves
   * anything on the way out saves it here and not there.
   *
   * A bot that *does* install a SIGTERM handler is not harmed: it simply gets
   * the other signal, and any code prepared for one is prepared for the other.
   */
  stopCommand: 'signal:SIGINT',

  /**
   * `immediate`, and it is the honest answer rather than a shortcut.
   *
   * The alternatives cannot work. A `port` strategy knocks on something
   * listening, and a bot listens on nothing — it dials out to Discord. A `log`
   * strategy needs a line the process is guaranteed to print, and what a bot
   * prints is whatever its author wrote; there is no equivalent of srcds's
   * Steam login. So the server counts as running once its container is, which
   * is exactly what the daemon does when a template declares nothing — the
   * difference is that this template says so, and an operator reading it knows
   * the green dot means "the process started", not "the bot is on Discord".
   */
  readiness: { type: 'immediate' },

  configFiles: [],
  fileDenylist: [],

  installContainer: 'python:3.13-slim',
  installEntrypoint: '/bin/bash',
  installScript: pythonInstallScript,

  /**
   * Not declared, and deliberately.
   *
   * The field refuses an installation when the volume's filesystem has less
   * than the figure free, and it is meant for a knowable, large number — a
   * Steam depot's size. What a bot's dependency tree weighs is whatever its
   * author put in requirements.txt: a few hundred kilobytes for a bot on
   * discord.py alone, a gigabyte and a half if it pulls in torch. A guess here
   * would refuse installations that would have worked.
   */
  installRequiredDiskBytes: undefined,

  variables: [
    discordTokenVariable,
    {
      name: 'Bot file',
      description:
        'The file python runs, relative to the server root. It is the entry point, not every file your bot has.',
      envVariable: 'PY_FILE',
      defaultValue: 'bot.py',
      userViewable: true,
      userEditable: true,
      /**
       * A path, and therefore narrowed like the Source templates' map name.
       * A subdirectory is allowed because bots are routinely laid out as
       * `src/main.py`, so `/` is in the class — `..` is what has to stay out,
       * and the expression admits a dot only where an extension needs one.
       */
      rules: 'required|string|regex:/^[A-Za-z0-9_-]+(\\/[A-Za-z0-9_-]+)*\\.py$/',
    },
    {
      name: 'Package path',
      description: 'Where Reinstall puts the packages from requirements.txt.',
      envVariable: 'PYTHONPATH',
      defaultValue: DEPS_RUNTIME_PATH,
      /**
       * Hidden and locked, because it is not a setting: it is the second half
       * of the contract the install script writes the first half of. An
       * operator who changed it would get a bot that starts and fails on its
       * first import, with nothing connecting that to a field they edited.
       */
      userViewable: false,
      userEditable: false,
      rules: 'required|string',
    },
  ],
};

export const discordBotNode: TemplateDefinition = {
  key: 'discord-bot-node',
  group: TEMPLATE_GROUPS.DISCORD,
  name: 'Discord bot (Node.js)',
  description:
    'Runs a Node.js Discord bot you upload yourself - discord.js, Eris, anything with a package.json. Dependencies are installed by Reinstall, from the lockfile when there is one. No git clone: upload through the file manager or SFTP.',
  author: 'Hopper',

  dockerImages: [
    { name: 'Node 22', image: 'node:22-bookworm-slim' },
    { name: 'Node 20', image: 'node:20-bookworm-slim' },
  ],

  /**
   * No `-u` equivalent is needed, unlike the Python template above: Node writes
   * to a pipe asynchronously but does not sit on a block buffer, so a bot's
   * `console.log` reaches the console as it is written.
   */
  startup: 'node {{MAIN_FILE}}',

  /**
   * SIGINT, for the same reason as the Python template and with one difference
   * worth knowing: Node's *default* action for SIGINT with no listener is to
   * exit, so a bot that handles nothing still stops cleanly, and one that
   * registers `process.on('SIGINT')` gets the chance to close its gateway
   * connection and flush whatever it was writing.
   */
  stopCommand: 'signal:SIGINT',

  /** See the Python template: a bot listens on nothing and prints nothing fixed. */
  readiness: { type: 'immediate' },

  configFiles: [],
  fileDenylist: [],

  installContainer: 'node:22-bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: nodeInstallScript,

  /** Unknowable in advance, exactly as for the Python template. */
  installRequiredDiskBytes: undefined,

  variables: [
    discordTokenVariable,
    {
      name: 'Entry point',
      description:
        'The file node runs, relative to the server root. Match whatever your package.json calls main.',
      envVariable: 'MAIN_FILE',
      defaultValue: 'index.js',
      userViewable: true,
      userEditable: true,
      /** As for the Python file, plus the two extensions Node actually loads. */
      rules: 'required|string|regex:/^[A-Za-z0-9_-]+(\\/[A-Za-z0-9_-]+)*\\.(js|mjs|cjs)$/',
    },
  ],
};

export const DISCORD_TEMPLATES: TemplateDefinition[] = [discordBotPython, discordBotNode];
