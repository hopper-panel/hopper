import { TEMPLATE_GROUPS, type TemplateDefinition } from '../definition.js';

/**
 * Factorio — the first server in this catalogue that is not Minecraft.
 *
 * Nearly every assumption the templates beside it are built on fails here, and
 * that is the reason it is the one shipped first:
 *
 *  • there is no JVM. `JAVA_IMAGES` means nothing to it and no part of this
 *    template reads `SERVER_MEMORY`, because Factorio sizes its own
 *    allocations from the map it loads and has no heap flag to hand one to;
 *  • there is no `server.properties`, and no configuration file the panel has
 *    to rewrite at all — the port arrives as a command-line argument, so
 *    `configFiles` below is empty rather than merely different;
 *  • the game port is UDP. A `port` readiness would knock on TCP 34197, where
 *    nothing is listening, and report a perfectly healthy server as dead for
 *    the whole timeout — which is precisely why the daemon refuses a `udp`
 *    probe instead of quietly downgrading it. `log` is the only strategy that
 *    can answer for this game;
 *  • it announces itself with `Hosting game at IP ADDR`, a line no Bukkit
 *    pattern would ever match and no `Done (12.4s)!` regex would either.
 *
 * The install is a public tarball — no Steam account, no credentials, nothing
 * to hold in a secret — which is what makes it something continuous
 * integration can actually run end to end.
 */

/**
 * The line the multiplayer manager prints once the game is being served.
 *
 * It stops where it does on purpose. The binary's format string is `Hosting
 * game at %s`, and everything after it is the address rendering itself — a
 * rendering whose punctuation has already moved between releases, from
 * `IP ADDR:{…}` to `IP ADDR:({…})`. Matching up to `ADDR` catches both and
 * whatever comes next; reaching into the braces would tie this template to one
 * version of a string it does not control.
 */
const HOSTING_MARKER = 'Hosting game at IP ADDR';

export const factorio: TemplateDefinition = {
  key: 'factorio',
  group: TEMPLATE_GROUPS.OTHER_GAMES,
  name: 'Factorio',
  description:
    "The official headless server, installed from Factorio's public download. Generates a map during installation and serves it. Installed as a private, direct-connect server: publishing it on the public server list needs factorio.com credentials. Server name, password and player limit are edited in data/server-settings.json.",
  author: 'Hopper',

  /**
   * One image, and deliberately not a choice.
   *
   * The headless build is an ordinary x86-64 ELF that needs glibc and nothing
   * else — no runtime to pick a version of, so a list of images would invite a
   * decision that does not exist. It is the same Debian the install container
   * uses below, which matters more than it looks: the install script runs the
   * game binary to generate the map, and installing against one libc while
   * starting against another would produce a world made by a binary that
   * cannot run at start.
   *
   * Same image, not the same *filesystem*, and that catches people out: the
   * install container installs curl and jq and their `ca-certificates` into a
   * layer that is discarded when the installation ends, and only the volume
   * survives into the run. A running server has no system trust store at all —
   * `/etc/ssl/certs` is empty in this image, verified, not assumed — so nothing
   * that reaches for one works here. The game itself is not affected: the
   * archive ships `data/cacert.pem` and the binary names it, which is how a
   * headless Factorio talks to factorio.com without the distribution's
   * certificates. Anything *this template* were to add that expected a system
   * bundle would fail, and the seeded configuration below is the one that never
   * has to find out, because it makes no outbound call in the first place.
   */
  dockerImages: [{ name: 'Debian 12', image: 'debian:bookworm-slim' }],

  /**
   * Relative to the volume, which Docker makes the working directory.
   *
   * No `--bind`: the process has to listen on every interface of the
   * container, and Docker is what restricts publication to the allocated port
   * — the same reasoning that pins `server-ip` to `0.0.0.0` for a Minecraft
   * server. `{{SERVER_IP}}` is the *host's* address, and binding to it from
   * inside the container would fail outright.
   *
   * `--port` is also why this template declares no configuration file: there
   * is nothing on disk holding the port for the daemon to rewrite.
   *
   * `--start-server-load-latest`, and not `--start-server saves/<name>.zip`.
   * The named form is the obvious one and it throws away the only thing that
   * makes an unattended server survivable. Factorio autosaves on a rotation —
   * `saves/_autosave1.zip` and its siblings, every few minutes — and rewrites
   * the save it was started from **only** on a clean shutdown. Naming one file
   * means those autosaves are written, are counted against the disk quota, and
   * can never be loaded by any start this template can produce: a host that
   * loses power comes back to the last clean stop, with minutes-old recovery
   * data sitting unreachable beside it.
   *
   * Load-latest takes the most recent save in `saves/`. After a clean stop
   * that is the very file the named form would have chosen, because Factorio
   * has just written the loaded world back to it; after a kill it is the
   * newest autosave. Both were run on 2.0.77 rather than reasoned about: a
   * server stopped with `/quit` rewrote `gamesave.zip` and reloaded it, and
   * the same server SIGKILLed two minutes after an autosave came back on
   * `_autosave2.zip` — the world it actually had, not the one it had last
   * shut down with. The two forms differ only in that second case, and only
   * the named one loses.
   *
   * Two things it costs, both accepted knowingly:
   *
   *  • a world is no longer chosen by name. An operator who uploads
   *    `myworld.zip` gets it only if it is the newest file in `saves/`, and
   *    autosaves left by a previous world would shadow it. Visible (the loaded
   *    save is named in the console at every start), recoverable from the file
   *    manager, and said out loud by the installation — against a data loss
   *    that is recoverable by nobody;
   *  • a server recovered from `_autosave2.zip` carries on under that name
   *    until someone renames it, and the rotation will overwrite that slot
   *    again later. Nothing is lost when it does: every autosave is a newer
   *    state of the same world, so the newest file stays the right one to
   *    load.
   */
  startup:
    './bin/x64/factorio --start-server-load-latest ' +
    '--server-settings data/server-settings.json --port {{SERVER_PORT}}',

  /**
   * Factorio reads server commands from its standard input, so a stop travels
   * down the same channel the console writes to.
   *
   * The leading slash is part of the command, not decoration: Factorio's
   * console tells a command from a chat message by it, and `quit` without one
   * is broadcast to the players while the server keeps running until the
   * daemon's timeout expires and kills it.
   *
   * That it saves before exiting is the assertion the whole stop path rests
   * on, so here is where it comes from rather than an assurance. A 2.0.77
   * headless server, stopped this way, prints:
   *
   *     Quitting: remote-quit.
   *     Info MainLoop.cpp:437: Saving map as /mnt/server/saves/gamesave.zip
   *     Info MainLoop.cpp:448: Saving progress: 100.000000%
   *     …
   *     Goodbye
   *
   * — the world written back to the file it was loaded from, then the exit.
   * That is the behaviour, and the way to re-check it after a release is to
   * stop a server and read those lines; no test in this repository can, since
   * it takes the game to produce them.
   *
   * The save is also the risk, because it is unbounded. That one took about a
   * second and a half for a freshly generated map; a mature factory is orders
   * of magnitude larger. The daemon SIGKILLs whatever is still running once
   * `stopTimeoutSeconds` elapses, and a kill landing inside that write is the
   * one way this stop loses data — which is what the field below is for.
   */
  stopCommand: 'command:/quit',

  /**
   * Four minutes, where the contract's default is thirty seconds.
   *
   * Thirty is a Minecraft figure and this is not Minecraft. A Bukkit server
   * flushes the regions it has dirtied; Factorio serialises the **whole world**
   * on every clean exit, and the time that takes scales with the factory, not
   * with what has recently changed. The measured second and a half above was a
   * map generated minutes earlier — the smallest world this template can
   * produce, and the least useful number for sizing a deadline.
   *
   * So the figure is chosen from what it costs to be wrong in each direction,
   * which is deeply asymmetric here. Too long costs an operator staring at a
   * stopping server for a few extra minutes, once, and they can press Kill.
   * Too short cuts the process mid-write: `--start-server-load-latest` then
   * comes back on the newest **autosave** instead, and everything built since
   * that autosave is gone. Four minutes is well past any save this game
   * plausibly performs and still inside the ten-minute ceiling the contract
   * puts on a stop.
   *
   * Not a value this template could set until now, and the reason the field
   * exists: every Factorio server created before it ran on the Minecraft
   * default.
   */
  stopTimeoutSeconds: 240,

  /**
   * Kept for a node running a daemon older than the `readiness` union.
   *
   * Such a node reads nothing but this field, and a template that dropped it
   * would leave that node with no way to tell a started server from a ready
   * one — it would call the server running the instant its container came up.
   * It holds the first of the patterns below, because a single string is all
   * it can hold.
   */
  startupDetection: HOSTING_MARKER,

  /**
   * Two markers, which is the thing `startupDetection` could not express.
   *
   * Both are printed within a millisecond of the save finishing loading, and
   * either one alone is proof the server is serving: the first arrives with no
   * `Info File.cpp:NNN:` prefix at all, the second is the multiplayer
   * manager's state machine reaching `InGame`, printed as
   * `updateTick(N) changing state from(CreatingGame) to(InGame)`. Listing both
   * is insurance against either wording moving between releases — this
   * template pins no version, so it has to survive the build it is installed
   * with changing under it, and a readiness that stops matching does not
   * degrade quietly: the server sits in `starting` until the deadline below
   * fails the start.
   */
  readiness: {
    type: 'log',
    patterns: [
      HOSTING_MARKER,
      // Escaped: the parentheses are part of the line, not a capture group.
      'changing state from\\(CreatingGame\\) to\\(InGame\\)',
    ],
    /**
     * Five minutes, and naming a figure at all is the point.
     *
     * There is no default. A template that says nothing here keeps the
     * open-ended wait, which is what every template had before deadlines
     * existed and what every imported egg still has — so declaring a number is
     * how this template opts into a start that is allowed to fail rather than
     * spin for ever.
     *
     * Five is sized on the observed thing, not on a round number: a headless
     * Factorio spends its startup loading prototypes, measured at thirty-seven
     * seconds on a first run of 2.0.77 with the Space Age data, and a save
     * large enough to be counted in gigabytes adds seconds rather than
     * minutes. Anything still silent after five minutes is a start that has
     * already failed, and the operator should be told so.
     */
    timeoutMs: 300_000,
  },

  /**
   * Empty, and worth stating rather than leaving to inference.
   *
   * The port — the one setting the panel genuinely owns — is passed on the
   * command line, so nothing on disk needs rewriting before a start. The rest
   * of the server's settings live in `data/server-settings.json`, seeded from
   * the archive's example during installation — patched once, there, into a
   * configuration that can actually boot — and edited from the file manager
   * afterwards.
   *
   * They are deliberately not panel variables. The JSON rewriter writes every
   * replacement as a **string**, and `max_players` and the autosave counts are
   * numbers in Factorio's own schema: handing it `"20"` where it expects `20`
   * makes the server refuse the file and exit. Wiring only the string-typed
   * keys would work, and would silently take ownership of a file the operator
   * edits by hand — their name and password would be reverted on the next
   * start with nothing said about it.
   */
  configFiles: [],
  fileDenylist: [],

  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    '#!/bin/bash',
    '# set -e: a failing step has to stop the installation. An install that',
    '# reports success over half an archive produces a server that exits a',
    '# second after every start, with nothing in the console to connect that',
    '# back to the download.',
    'set -euo pipefail',
    '',
    'apt-get update',
    '# xz-utils: the headless build ships as a .tar.xz and tar cannot open one',
    '# without it — it fails with "Cannot exec xz", well after a download that',
    '# appeared to go fine.',
    'apt-get install -y --no-install-recommends curl jq tar xz-utils ca-certificates',
    '',
    'mkdir -p /mnt/server',
    'cd /mnt/server',
    '',
    'RELEASES="https://factorio.com/api/latest-releases"',
    '',
    '# "stable" and "experimental" are the two channels Factorio publishes, and',
    '# the headless build carries its own version number under each of them.',
    '# Anything else is taken as written, so a world can be pinned to the exact',
    '# build it was generated with — the variable\'s rule is what keeps "anything',
    '# else" to something that can only ever be a version number, because this',
    '# value goes on to be a segment of the download URL.',
    'case "${FACTORIO_VERSION}" in',
    '  stable|latest)',
    '    VERSION=$(curl -sSL --fail "${RELEASES}" | jq -r ".stable.headless")',
    '    ;;',
    '  experimental)',
    '    VERSION=$(curl -sSL --fail "${RELEASES}" | jq -r ".experimental.headless")',
    '    ;;',
    '  *)',
    '    VERSION="${FACTORIO_VERSION}"',
    '    ;;',
    'esac',
    '',
    '# jq prints the string "null" for a key it did not find, and that string',
    '# would go on to build a download URL that answers 404 several steps later.',
    'if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then',
    '  echo "Could not resolve a Factorio version from \'${FACTORIO_VERSION}\'." >&2',
    '  exit 1',
    'fi',
    '',
    'echo "Installing Factorio headless ${VERSION}"',
    '',
    'ARCHIVE="factorio-headless-${VERSION}.tar.xz"',
    '',
    '# /get-download redirects to a CDN and answers 404 for a version that was',
    '# never released, which is what makes --fail enough to catch a typo in the',
    '# version above rather than let it become an empty file.',
    'curl -sSL --fail -o "${ARCHIVE}" \\',
    '  "https://factorio.com/get-download/${VERSION}/headless/linux64"',
    '',
    '# Checked before a single file is unpacked. --fail already turns a 404 into',
    '# a failure, but a redirect landing on an error page leaves a perfectly',
    '# valid HTML document under an archive name, and tar would only say so',
    '# after it had begun writing over the previous installation.',
    'if ! tar -tJf "${ARCHIVE}" > /dev/null 2>&1; then',
    '  echo "What was downloaded for ${VERSION} is not a Factorio archive." >&2',
    '  exit 1',
    'fi',
    '',
    '# --strip-components=1: everything in the archive sits under a "factorio/"',
    '# directory, and the server has to end up at the root of the volume for the',
    '# startup command to be able to name ./bin/x64/factorio.',
    'tar -xJf "${ARCHIVE}" --strip-components=1 -C /mnt/server',
    'rm -f "${ARCHIVE}"',
    '',
    'if [ ! -x bin/x64/factorio ]; then',
    '  echo "The archive contained no executable bin/x64/factorio." >&2',
    '  exit 1',
    'fi',
    '',
    '# config-path.cfg decides where Factorio keeps the data it writes:',
    '# player-data.json, the mods directory, its temporary files. The headless',
    '# archive ships it set to "false", meaning the install directory — which',
    '# here is the volume, the one place the server may write and the only one',
    '# the file manager and the backups can see. That default matters far more',
    '# in a container than it does on a desktop: "true" would send those writes',
    '# to a home directory, and the server runs as an unprivileged uid present',
    '# in no /etc/passwd, so HOME is "/" and the very first start would die on a',
    "# permission error naming a path nobody configured. It is upstream's value",
    '# to change, so it is checked rather than trusted — and patched in place',
    "# rather than rewritten, because the file's own comments explain the",
    '# setting to whoever opens it next.',
    '#',
    '# The file is proved to exist first, like every other expectation this',
    '# script has of the archive. grep on a missing file exits 2, an `if` reads',
    '# any non-zero status as "no match", and set -e does not apply inside a',
    '# condition — so a build that stopped shipping config-path.cfg would sail',
    '# past this block in silence and fail at the first start instead, on a',
    '# permission error naming a path this script had been asked to fix.',
    'if [ ! -f config-path.cfg ]; then',
    '  echo "The archive shipped no config-path.cfg." >&2',
    '  exit 1',
    'fi',
    '',
    "if grep -q '^use-system-read-write-data-directories=true' config-path.cfg; then",
    '  echo "Pointing Factorio\'s writable data back at the server directory:"',
    '  echo "this build shipped it aimed at a home directory the container has"',
    '  echo "no equivalent of."',
    "  sed -i 's/^use-system-read-write-data-directories=true/use-system-read-write-data-directories=false/' \\",
    '    config-path.cfg',
    'fi',
    '',
    '# The archive holds bin/, data/ and config-path.cfg, and nothing else:',
    '# there is no saves directory for --create to write into yet.',
    'mkdir -p saves',
    '',
    '# The archive ships these three as .example.json, and Factorio reads the',
    '# names without the suffix. The startup command names',
    '# data/server-settings.json outright, so leaving the examples untouched',
    '# would start the server against a file that does not exist — which it',
    '# refuses to do. Copied rather than moved, so the examples survive for an',
    '# operator who wants to start over.',
    '#',
    '# SEEDED_SETTINGS records whether *this run* created server-settings.json.',
    '# The patch below applies to that file and to no other: a settings file the',
    '# operator already has is theirs, and a reinstall that quietly switched',
    '# their published server back to private would be a worse bug than the one',
    '# the patch fixes.',
    'SEEDED_SETTINGS=0',
    '',
    'for settings in server-settings map-gen-settings map-settings; do',
    '  if [ -f "data/${settings}.json" ]; then',
    '    continue',
    '  fi',
    '',
    '  if [ ! -f "data/${settings}.example.json" ]; then',
    '    echo "The archive ships no data/${settings}.example.json." >&2',
    '    exit 1',
    '  fi',
    '',
    '  cp "data/${settings}.example.json" "data/${settings}.json"',
    '',
    '  if [ "${settings}" = "server-settings" ]; then',
    '    SEEDED_SETTINGS=1',
    '  fi',
    'done',
    '',
    '# The example is copied verbatim and it describes a server nobody has: it',
    '# ships visibility.public = true and require_user_verification = true with',
    '# username and token empty, which is an account this installation does not',
    '# have and cannot ask for.',
    '#',
    '# What a 2.0.77 server does with that file, run rather than assumed: it',
    '# starts, loads the map, prints its hosting line — and then fails to',
    '# register, with "Matching server connection failed: Error when creating',
    '# server game: Missing token." So the panel reports a healthy server, the',
    '# public list it claims to be on never shows it, and every player who tries',
    '# to join is sent to factorio.com to be verified by a server with no',
    '# account there. It is a start that succeeds into a configuration that',
    '# cannot do what it says.',
    '#',
    '# So the seeded file is patched to the one configuration that is coherent',
    '# without an account: private, unverified, joined by address. Both values',
    "# are the operator's afterwards — this is a starting point, not a policy —",
    '# and the block below names all three fields they have to set, because the',
    '# obvious half-measure is a hard refusal: public = true with verification',
    '# left false makes the server exit at once with "require_user_verification',
    '# must be enabled for public games."',
    '#',
    '# It also leaves the running server making no outbound call whatsoever,',
    '# which is worth knowing about before adding anything here that expects the',
    '# network: the runtime container has no system trust store at all. The',
    '# ca-certificates installed above go into this container, which is thrown',
    '# away when the installation ends; only the volume survives. Factorio itself',
    '# is fine either way, it ships its own bundle in data/cacert.pem — but',
    '# nothing else in that image is.',
    '#',
    '# jq rather than sed: this is JSON, the keys are nested, and a regular',
    '# expression walking JSON is how a settings file ends up unparseable and a',
    '# server ends up refusing to start with no clue why. jq cannot write the',
    '# file it is reading, hence the temporary — and if it fails, set -e stops',
    '# the installation before the mv, leaving the original intact.',
    'if [ "${SEEDED_SETTINGS}" = "1" ]; then',
    "  jq '.visibility.public = false | .require_user_verification = false' \\",
    '    data/server-settings.json > data/server-settings.json.seeded',
    '  mv data/server-settings.json.seeded data/server-settings.json',
    '',
    '  echo "==============================================================="',
    '  echo "This server is PRIVATE, and that is a decision this installation"',
    '  echo "made for you. data/server-settings.json was seeded with:"',
    '  echo "    visibility.public          false"',
    '  echo "    require_user_verification  false"',
    '  echo "The example that file comes from asks to be published on the"',
    '  echo "public server list, which needs a factorio.com account this"',
    '  echo "installation has no way to know. A server left that way starts,"',
    '  echo "and then never appears on the list it thinks it is on."',
    '  echo ""',
    '  echo "Players join this one by address: Multiplayer, then Connect to"',
    '  echo "address, with the address and port shown in the panel. LAN"',
    '  echo "discovery is left on, so it still shows up on a local network."',
    '  echo ""',
    '  echo "To publish it, edit data/server-settings.json and set ALL of:"',
    '  echo "    visibility.public          true"',
    '  echo "    require_user_verification  true"',
    '  echo "    username                   your factorio.com username"',
    '  echo "    token                      your factorio.com token"',
    '  echo "The token is on your factorio.com profile page. Setting public"',
    '  echo "on its own makes the server refuse to start: Factorio requires"',
    '  echo "user verification for public games."',
    '  echo "==============================================================="',
    'fi',
    '',
    'SAVE="saves/${SAVE_NAME}.zip"',
    '',
    '# The point of this whole script. The startup command loads the most recent',
    '# save in saves/, and an empty saves/ makes Factorio print one line and',
    '# exit — a server that dies a second after every start reads as a crash',
    '# rather than as a missing map. So a world is made here, once, and never',
    '# overwritten: a reinstall repairs the binaries and leaves the saves alone.',
    '#',
    "# The name is still this script's business even though the startup command",
    '# no longer names it: --create has to be told where to write, and an',
    '# operator who reinstalls has to be able to see that the world already',
    '# there is the one they generated.',
    'if [ -f "${SAVE}" ]; then',
    '  echo "Keeping the existing save ${SAVE}."',
    'elif [ "${GENERATE_SAVE}" = "1" ]; then',
    '  echo "Generating a new map in ${SAVE}."',
    '  ./bin/x64/factorio --create "${SAVE}" \\',
    '    --map-gen-settings data/map-gen-settings.json \\',
    '    --map-settings data/map-settings.json',
    '',
    '  # The file is checked, not the exit code. set -e already catches a',
    '  # --create that failed; what it cannot catch is a --create that succeeded',
    '  # somewhere other than where the startup command will look. This is the',
    '  # only place those two paths can be compared, and they have to agree.',
    '  if [ ! -f "${SAVE}" ]; then',
    '    echo "Factorio exited successfully but wrote no ${SAVE}." >&2',
    '    exit 1',
    '  fi',
    'else',
    '  # Not a failure: turning generation off is how an operator says they will',
    '  # bring their own world, and failing the installation would leave them no',
    '  # server to upload it to. Loud all the same — the alternative is finding',
    '  # out at the first start.',
    '  echo "===============================================================" >&2',
    '  echo "No save in saves/, and map generation is turned off." >&2',
    '  echo "Upload your world into saves/ before starting this server:" >&2',
    '  echo "with nothing to load Factorio exits at once, saying" >&2',
    '  echo "  No latest save file found in .../saves." >&2',
    '  echo "and the start is reported as a failure." >&2',
    '  echo "" >&2',
    '  echo "The name does not matter, being the newest file does: this" >&2',
    '  echo "server starts on the most recent save in saves/, which is what" >&2',
    '  echo "lets it come back on an autosave after a crash. A world dropped" >&2',
    '  echo "next to autosaves left by an earlier one will not be loaded if" >&2',
    '  echo "any of them is newer, so clear those out first." >&2',
    '  echo "===============================================================" >&2',
    'fi',
    '',
    'echo "Factorio ${VERSION} installed."',
    '# Said out loud because these are not panel variables: an operator who goes',
    '# looking for a "server name" field has to be told where it actually lives.',
    'echo "Server name, description, password and player limit are in"',
    'echo "data/server-settings.json — edit it from the file manager."',
    '# And said here too, because the paragraph above only prints on a first',
    "# installation: a reinstall keeps the operator's settings file and skips it.",
    'echo "That file is also where a server is made public, which needs a"',
    'echo "factorio.com username and token. Until then it is private and"',
    'echo "players join it by address."',
  ].join('\n'),

  variables: [
    {
      name: 'Factorio version',
      description: '"stable", "experimental", or an exact version such as 2.0.28.',
      envVariable: 'FACTORIO_VERSION',
      defaultValue: 'stable',
      userViewable: true,
      /**
       * Editable: it is the one thing a reinstall exists to change, and a save
       * made by a newer build cannot be loaded by an older one — pinning the
       * version is how an operator stays on the build their world came from.
       *
       * Narrowed for the same reason `SAVE_NAME` below is: this value becomes a
       * **path segment**, of
       * `https://factorio.com/get-download/${VERSION}/headless/linux64`, and
       * curl resolves `../` in a URL path before it sends anything — so an
       * unconstrained string here chooses which URL the installation fetches
       * its binaries from. `max:20` bounded the length and nothing else.
       *
       * Written as a character class and not as an alternation of the three
       * channel words and a dotted version, which is what it would like to be.
       * That was forced: the panel used to split the rule string on `|` before
       * looking for `regex:`, which tore an alternation into fragments the
       * first of which no longer compiled — and an expression that would not
       * compile was treated as the template's fault and passed every value. The
       * class survived only because it contains no pipe. The panel now scans
       * for the delimiters instead of splitting, so an alternation here would
       * hold, and a rule that will not compile refuses the value rather than
       * waving it through. The class is kept because it is correct and in use;
       * narrowing it to an alternation is a separate decision about what a
       * version may be, not a workaround any more.
       *
       * What it admits: `stable`, `experimental`, `latest`, and `2.0.28`. What
       * it excludes is what matters — no `/`, `%`, `:`, `@`, `?` or `\`, so
       * nothing here can leave its segment or reach another host, and a leading
       * digit-or-letter means the value cannot be `..` or begin with a dot.
       * Anything else that gets through is a version that does not exist, which
       * the resolution above already refuses by name.
       *
       * The length bound lives inside the expression rather than in `max:20`,
       * for the reason spelled out under `SAVE_NAME`.
       */
      userEditable: true,
      rules: 'required|string|regex:/^[0-9a-z][0-9a-z.]{0,19}$/',
    },
    {
      name: 'Save name',
      description:
        'Name of the save generated during installation, under saves/ and without the .zip extension. The server starts on the most recent save in that directory, whatever it is called.',
      envVariable: 'SAVE_NAME',
      defaultValue: 'gamesave',
      userViewable: true,
      /**
       * Editable, and narrowed hard, because this value becomes a **path**:
       * `saves/${SAVE_NAME}.zip` in the install script, where `--create` is
       * told where to write and the result is checked for. The character class
       * is what stops `../` from naming a file outside `saves/`, and stops a
       * dot from turning the name into a different file than the one that was
       * generated.
       *
       * It no longer appears in the startup command — that loads the newest
       * save rather than a named one, see above — which narrows what this
       * variable can do wrong but does not remove it from a path.
       *
       * The length lives inside the expression rather than in a `max:` rule on
       * purpose: `max:` compares a value that parses as a number by its value,
       * not its length, so `max:64` would refuse a save called `2024` with a
       * message about a number being too large.
       */
      userEditable: true,
      rules: 'required|string|regex:/^[A-Za-z0-9_-]{1,64}$/',
    },
    {
      name: 'Create a save if none exists',
      description:
        '1 to generate a new map during installation. 0 to upload your own save instead — the server will not start until you do.',
      envVariable: 'GENERATE_SAVE',
      defaultValue: '1',
      userViewable: true,
      /**
       * Read only by the install script, and editable because turning it off
       * is the whole procedure for bringing an existing world: set it to 0,
       * install, upload the save into `saves/`, start. The name it is uploaded
       * under is free — being the newest file in `saves/` is what decides what
       * loads — and the installation says so at the point it applies.
       */
      userEditable: true,
      rules: 'required|in:0,1',
    },
  ],
};

export const FACTORIO_TEMPLATES: TemplateDefinition[] = [factorio];
