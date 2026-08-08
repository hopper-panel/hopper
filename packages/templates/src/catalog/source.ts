import { TEMPLATE_GROUPS, type TemplateDefinition } from '../definition.js';

/**
 * The Source engine, and Garry's Mod as its first template.
 *
 * Named for the engine rather than for the game because almost nothing below is
 * about Garry's Mod: `srcds_run`, `-norestart`, the console on standard input,
 * the anonymous SteamCMD depot and the `.steam/sdk32` the engine falls back to
 * for `steamclient.so` are shared by every Source dedicated server there is, and
 * the second one added here should be able to read this file rather than
 * rediscover it. What is genuinely Garry's Mod is the app id, the `-game`
 * directory, the gamemode variable and the disk figure — and, measured here,
 * that its depot ships the Steam client library itself so the fallback is never
 * reached; the next game on this engine should check that rather than assume it.
 *
 * It is also the first template in this catalogue that installs from Steam, and
 * that is the part with teeth. Two of Hopper's own decisions become visible the
 * first time a depot is downloaded, both documented at length in
 * `docs/templates.md` under "Installing from SteamCMD", and both punished by a
 * server that looks like it worked:
 *
 *  • `+force_install_dir /mnt/server` decides whether the six gigabytes land in
 *    the volume or in a container layer that is deleted seconds later;
 *  • `-norestart` decides whether a graceful stop is a graceful stop or a
 *    SIGKILL at the timeout, every single time.
 *
 * A third was listed here — that `su` cannot work in the install container for
 * want of `AUDIT_WRITE` — and it is not true: `su steam -c …` returns 0 under
 * exactly the capability set the daemon grants. That page now records the
 * correction and the one thing about it still unmeasured; nothing in this file
 * needs to act on either, because nothing here switches user.
 *
 * Factorio is the precedent for the rest, and the two disagree in exactly one
 * interesting place: Factorio serialises its whole world on the way out and had
 * to ask for four minutes to do it, whereas srcds writes nothing at all on
 * `quit` and keeps the contract's thirty seconds. See `stopCommand` below.
 */

/**
 * The line srcds prints once the game server has logged in to Steam.
 *
 * This is the marker the published Pterodactyl Source eggs wait for, Garry's
 * Mod's included, across a family of games on the same engine — which is the
 * best evidence available that it survives the builds this template pins no
 * version of. It stops before the word that precedes it on purpose: the login
 * is `Assigned anonymous gameserver Steam ID` without a login token and
 * `Assigned persistent gameserver Steam ID` with one, and only the half they
 * share belongs in a pattern.
 *
 * What makes it a *readiness* marker rather than merely a late one is where it
 * sits in the sequence. srcds logs the game server in after the map has loaded
 * and the server has been activated — the engine has nothing to register until
 * there is a game to register — so by the time this line appears the server is
 * listening and will take a player.
 *
 * The cost, which is real and is the reason the second pattern below is not an
 * independent one: both markers come out of the Steam login, so a node that
 * cannot reach Steam prints neither and the start fails at the deadline. That
 * is the right answer rather than an accepted defect. A Garry's Mod server that
 * never logs in has no VAC, appears in no server browser and can load no
 * Workshop content; calling it ready would report a server nobody can find as
 * healthy.
 */
const STEAM_LOGIN_MARKER = 'gameserver Steam ID';

export const garrysMod: TemplateDefinition = {
  key: 'garrys-mod',
  /**
   * Beside Factorio, not in a group of its own.
   *
   * A "Source engine" group is the tempting shape and `TEMPLATE_GROUPS` argues
   * against it in its own comment: the group name is the upsert key, so it can
   * never be renamed, and a group per engine turns the create-server dropdown
   * into a list of one-entry sections. "Other games" was named for the category
   * precisely so the second and the tenth non-Minecraft template could join it
   * without a migration.
   */
  group: TEMPLATE_GROUPS.OTHER_GAMES,
  name: "Garry's Mod",
  description:
    "Garry's Mod, installed from Steam as an anonymous user — around six gigabytes, and Reinstall is how it is updated. Gamemode, map and player limit are startup variables; everything else lives in garrysmod/cfg/server.cfg, and garrysmod/addons is yours. Ships without Workshop, a Steam game-server login token and RCON.",
  author: 'Hopper',

  /**
   * One image, built by this repository, and both halves of that matter.
   *
   * `srcds_linux` is a 32-bit x86 binary in 2026, and an amd64 Debian carries no
   * i386 loader at all. What it needs turned out to be small and was measured
   * rather than guessed: `/proc/<pid>/maps` of a server sitting at both readiness
   * markers holds exactly eight files from outside the volume — `ld-linux.so.2`,
   * libc, libdl, libgcc_s, libm, librt, libpthread and libstdc++ — which
   * `docker/source/Dockerfile` supplies with three i386 packages, plus
   * `ca-certificates`, without which the Steam login fails on untrusted roots.
   * The libraries a Source image is usually told it needs — libcurl, SDL2,
   * tcmalloc — are deliberately *not* installed, and the Dockerfile says why for
   * each: libcurl is in no `NEEDED` entry of any object in the depot, and the
   * other two ship in the game's own `bin/`, which is where the running server
   * maps them from. `.github/workflows/source-image.yml` proves the eight are
   * loadable before the image is published. That workflow also pins the two things this template
   * silently depends on: no `ENTRYPOINT` and no `USER`, so the argv built from
   * the startup command below is what runs and the daemon's own uid is what runs
   * it, and `HOME=/home/container`, which is what makes the
   * `~/.steam/sdk32/steamclient.so` the install script writes resolve to a file
   * inside the volume rather than to a home directory nothing created.
   *
   * Built here rather than borrowed because `Server.dockerImage` is copied onto
   * the server row at creation: the string this template ships with today
   * outlives every later edit of the template and cannot be changed for the
   * servers already carrying it. A name this project does not control is a
   * permanent dependency on somebody else's retention policy.
   *
   * `:1` is the image's own major and does not move with Hopper's version. It
   * changes only if the image changes in a way that would stop an existing
   * server from starting, and then the new servers get `:2` while the old ones
   * keep the tag they were created with.
   */
  dockerImages: [{ name: 'Source engine', image: 'ghcr.io/hopper-panel/source:1' }],

  /**
   * Relative to the volume, which Docker makes the working directory.
   *
   * **`-norestart` is the flag this whole template turns on.** `srcds_run` is a
   * shell script that runs the server in a loop and starts it again whenever it
   * exits — the behaviour that keeps a crashed server alive on a bare machine,
   * and a disaster under a panel. What Hopper waits for on a stop is the
   * *container* going down, and the container is PID 1, which is the wrapper.
   * Without this flag the `quit` below is delivered, obeyed, and answered with a
   * fresh server; the wrapper never exits; `stopTimeoutSeconds` elapses; and the
   * SIGKILL lands on a replacement server that has been taking players for
   * thirty seconds. Every stop, every restart, every reinstall — each one
   * printing the console line about the server not having answered and data loss
   * being possible, which in that arrangement is the one thing the operator can
   * safely ignore and the one thing they will learn to.
   *
   * `-console` asks for the plain text console rather than a windowed one, which
   * is what every Source startup line in circulation carries and what a server
   * on a node wants either way.
   *
   * `-port` and no `+ip`. `{{SERVER_IP}}` is the address the allocation carries
   * **on the host**; no interface inside the container has it, and a server told
   * to bind to it does not start. The container has its own network namespace,
   * so the server binds everything in it and Docker is what publishes exactly
   * the allocated port — in TCP and UDP both, which is precisely the pair Source
   * wants: UDP for the game and its A2S queries, TCP for the RCON this template
   * does not turn on. That namespace is also why `-strictportbind` is absent:
   * the flag exists to stop srcds silently moving to the next free port when the
   * one it was given is taken, and nothing on the node shares this container's
   * network namespace to have taken it.
   *
   * `+map` last, and the order is not cosmetic. Source executes the `+commands`
   * from the command line in the order they are written, and `map` is the one
   * that loads the level and starts the server: anything after it is applied to
   * a server that is already up, so a player limit written there would take
   * effect on the second map rather than the first. Every reference command for
   * this game — the Garry's Mod wiki's included — puts `+maxplayers` and
   * `+gamemode` in front of it for that reason.
   *
   * Not here, deliberately, and each absence is a decision rather than an
   * oversight:
   *
   *  • **the Workshop** (`+host_workshop_collection` and the `-authkey` that
   *    goes with it). The key is a Steam Web API credential, and a template can
   *    only declare a variable whose value the panel stores and displays as
   *    ordinary text. There is no secret variable yet, and a credential in a
   *    field the file manager and the startup page both show is not one;
   *  • **the game-server login token** (`+sv_setsteamaccount`), same reason. The
   *    server logs in anonymously without it, which works and is what the
   *    readiness marker above reports;
   *  • **RCON** (`rcon_password`, and `-usercon` beside it). A password shipped
   *    in a template is the same password on every server anybody installs from
   *    it, and Hopper cannot yet generate a per-server default. The stop below
   *    does not need it in any case: this game reads its console from standard
   *    input;
   *  • **SourceTV** (`+tv_enable`), which wants a second port and a named
   *    allocation role — and a template that names a role is unusable on any
   *    node whose daemon predates names.
   */
  startup:
    './srcds_run -game garrysmod -console -norestart -port {{SERVER_PORT}} ' +
    '+maxplayers {{MAX_PLAYERS}} +gamemode {{GAMEMODE}} +map {{SRCDS_MAP}}',

  /**
   * The correction this template was written around.
   *
   * `docs/templates.md`, the contract's `stopConfigurationSchema` and the
   * daemon's own `sendStopOverRcon` docblock all listed Source among the games
   * that read no standard input, and sent them to RCON on the strength of it.
   * They were wrong. `srcds` reads its console from standard input — it is how
   * anybody who has ever run one inside `screen` stops it — and `quit` written
   * there is a clean shutdown: the server drops its players, closes its
   * sockets, logs out of Steam and exits. Measured on app 4020: `quit` down the
   * container's attach stream ends in exit code 0. All three now say so, and
   * each records the correction rather than having it quietly made, because a
   * wrong name in that list sends a game to RCON — a password, a port and four
   * fresh ways for a stop to be refused — for a channel it already had.
   *
   * No leading slash, unlike Factorio's `/quit`. That slash is Factorio's
   * console telling a command from a chat message; the Source console has no
   * such distinction and `/quit` would be an unknown command, answered with one
   * line of complaint and a server that carries on running until the timeout.
   *
   * The clean exit only reaches the daemon if the wrapper lets it. See
   * `-norestart` above; without it this string is delivered and obeyed and the
   * stop is still a kill.
   */
  stopCommand: 'command:quit',

  /*
   * **No `stopTimeoutSeconds`**, and the absence is the decision.
   *
   * Factorio asks for four minutes because it serialises its whole world on
   * every clean exit, and a SIGKILL landing inside that write is the one way its
   * stop loses data. None of that transfers. A Source server holds no world to
   * write: the map is a read-only file, and whatever state a gamemode keeps it
   * has already written wherever it keeps it. `quit` unloads the level and
   * exits, and there is no serialisation for a timeout to cut in half.
   *
   * So the contract's thirty seconds is the right figure, and saying nothing is
   * how a template asks for it — the field is optional precisely so that "this
   * template said nothing" stays distinguishable from "this template chose
   * thirty". Written down because a reader arriving from Factorio will expect a
   * number here and should know that its absence was considered.
   */

  /**
   * Kept for a node running a daemon older than the `readiness` union, which
   * reads this field and nothing else. It holds the first of the patterns
   * below, because a single string is all it can hold.
   */
  startupDetection: STEAM_LOGIN_MARKER,

  readiness: {
    /**
     * `log`, because nothing else can answer for this game.
     *
     * `port` is TCP only — the daemon refuses a UDP probe rather than knocking
     * on a TCP port nothing is listening on — and the game and its A2S queries
     * are UDP. The TCP half of the allocation belongs to RCON, which this
     * template does not enable, and `rcon` readiness would need the password
     * that comes with it.
     */
    type: 'log',
    /**
     * Two patterns, both from the same moment for the reason given above
     * {@link STEAM_LOGIN_MARKER}: there is no marker of a Source server being
     * ready that does not come out of its Steam login, so what these two insure
     * against is a wording moving between builds rather than Steam being
     * unreachable.
     *
     * `VAC secure mode is activated` is the line printed immediately after the
     * login. It is second because it is the more conditional of the two — a
     * server started insecure never prints it — and because the daemon takes
     * whichever arrives first, so listing the earlier marker first is what
     * decides the ordinary case.
     */
    patterns: [STEAM_LOGIN_MARKER, 'VAC secure mode is activated'],
    /**
     * Ten minutes, where Factorio takes five, and the difference is what an
     * operator is allowed to put in the volume.
     *
     * A stock Garry's Mod server is serving in well under a minute: it mounts
     * its content, loads one map and logs in. What is not bounded is
     * `garrysmod/addons`, which belongs to the operator and routinely holds a
     * gamemode that touches thousands of Lua files on every start — and the
     * first start after an install pays for a cold page cache on top. A deadline
     * shorter than the slowest honest start is a template that stops working the
     * day somebody adds a gamemode.
     *
     * Declaring a figure at all is the opt-in: with none, a start that has
     * failed sits in `starting` for ever. Ten minutes of a Source server saying
     * nothing is a start that is not going to happen.
     */
    timeoutMs: 600_000,
  },

  /**
   * Empty, like Factorio's and for the same reason: the port arrives as a
   * command-line argument, so there is nothing on disk holding it for the daemon
   * to rewrite before a start.
   *
   * `garrysmod/cfg/server.cfg` is deliberately not listed here. Hopper writes it
   * during an installation that finds nothing in it — the depot's own copy is
   * four bytes of line endings — and never again; see the install script. A
   * `configFiles` entry would take permanent ownership of a file the operator
   * edits by hand, and reverting their hostname on every start with nothing said
   * about it is the shape of bug that takes a week to believe.
   */
  configFiles: [],
  fileDenylist: [],

  /**
   * A different image from the one the server runs on, which is the first time
   * that has been true in this catalogue.
   *
   * Factorio installs and runs on the same Debian and explains why: its install
   * script runs the game binary to generate a map, so the two libcs have to
   * agree. Nothing here runs the game during installation, and the two
   * containers want opposite things — this one needs `apt-get` and a package
   * manager's worth of writable filesystem, the runtime image is a fixed set of
   * shared libraries with no build tools in it. SteamCMD is therefore installed
   * into this container's own layer, which is thrown away when the installation
   * ends, and the volume is left holding the game and nothing else.
   *
   * The consequence worth knowing: there is no SteamCMD in the runtime image, so
   * **Reinstall is how this server is updated**. That is not a workaround, it is
   * the intended shape — the install script below is idempotent, and running it
   * again is exactly what `+app_update … validate` is for.
   */
  installContainer: 'debian:bookworm-slim',
  installEntrypoint: '/bin/bash',
  installScript: [
    '#!/bin/bash',
    '# set -e: a failing step has to stop the installation. An install that',
    '# reports success over half a depot produces a server that exits a second',
    '# after every start, with nothing in the console to connect that back to the',
    '# download.',
    'set -euo pipefail',
    '',
    '# ---------------------------------------------------------------------',
    '# What runs this',
    '# ---------------------------------------------------------------------',
    '# Nothing below switches user, because nothing below wants another uid: the',
    '# apt-get needs root, SteamCMD runs perfectly well as root when its HOME is',
    '# writable, and the volume it writes into is chowned by the daemon after',
    '# this container is gone.',
    '#',
    '# This comment used to say something stronger and false — that su *cannot*',
    '# work here, because the install container is handed seven capabilities',
    '# (apps/daemon/src/server/installer.ts) and AUDIT_WRITE is not one of them.',
    '# It does work: "su steam -c ..." returns 0 under exactly that set. The one',
    '# thing still unmeasured is a host with auditd actually running, where the',
    '# kernel could refuse the login record; docs/templates.md carries the full',
    '# correction. A script that does want another uid is better off with',
    '# "runuser -u steam --" or "setpriv --reuid=... --regid=... --" anyway,',
    '# since those need only the granted SETUID and SETGID and so cannot depend',
    "# on the node's audit configuration at all.",
    '',
    '# i386, and the dpkg line is load-bearing rather than ceremonial: without it',
    '# apt fetches no i386 package lists at all and the install below fails with',
    '# "Unable to locate package". SteamCMD ships a 32-bit bootstrap binary, so a',
    '# 64-bit Debian cannot execute it until the second architecture exists.',
    '# libstdc++6:i386 pulls libgcc-s1:i386 and libc6:i386 in with it, which is',
    "# the whole of the 32-bit runtime SteamCMD needs — the game's own 32-bit",
    "# libraries are the runtime image's problem, not this container's.",
    'dpkg --add-architecture i386',
    'apt-get update',
    'apt-get install -y --no-install-recommends ca-certificates curl tar libstdc++6:i386',
    '',
    '# In this container, not in the volume. The community scripts unpack',
    '# SteamCMD into /mnt/server/steamcmd, which leaves fifty megabytes of client',
    "# in the operator's file manager, counted against their disk quota, for a",
    '# tool the runtime image cannot run anyway. Here it is discarded with the',
    '# container and the volume holds the game alone.',
    'STEAMCMD_DIR=/opt/steamcmd',
    'mkdir -p "${STEAMCMD_DIR}"',
    '',
    '# --fail, because without it curl writes an HTTP error page into the file',
    '# and exits 0, and tar then fails on something that is not an archive with a',
    '# message about the archive rather than about the download.',
    'curl -sSL --fail -o /tmp/steamcmd.tar.gz \\',
    '  "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz"',
    'tar -xzf /tmp/steamcmd.tar.gz -C "${STEAMCMD_DIR}"',
    'rm -f /tmp/steamcmd.tar.gz',
    '',
    'if [ ! -x "${STEAMCMD_DIR}/steamcmd.sh" ]; then',
    '  echo "What was downloaded is not a SteamCMD archive." >&2',
    '  exit 1',
    'fi',
    '',
    '# ---------------------------------------------------------------------',
    '# The depot',
    '# ---------------------------------------------------------------------',
    '# A long-standing SteamCMD failure: with no steamapps/ under the install',
    '# directory it reports a disk write error instead of creating one. Every',
    '# community Steam install script creates it in advance for that reason, and',
    '# one mkdir is cheaper than an error message that blames the disk.',
    'mkdir -p /mnt/server/steamapps',
    '',
    'cd "${STEAMCMD_DIR}"',
    '',
    '# +force_install_dir BEFORE +app_update, and it is not optional.',
    '#',
    '# SteamCMD applies it to the commands that follow and not to the ones',
    '# already run, and left unsaid it installs into a directory of its own under',
    "# this container's filesystem — the layer that is deleted the moment the",
    '# installation ends. The depot would download to completion, this script',
    '# would exit 0, and the server would start on an empty volume. It is also',
    "# the directory nothing measured: the daemon's disk preflight measures the",
    '# filesystem holding the volume and names no other, so the figure declared',
    '# in installRequiredDiskBytes would have been checked against a disk the',
    '# download never touched.',
    '#',
    "# +login anonymous: app 4020 is the public Garry's Mod dedicated server and",
    '# needs no account. Nothing in this template can hold a Steam password.',
    '#',
    '# The app id is written here rather than taken from a variable. One template',
    '# per game is the point: the readiness marker, the -game directory, the',
    "# gamemode variable and the disk figure below are all this app's, and a",
    '# variable app id would make every one of them a lie for whatever else was',
    '# typed into it.',
    '#',
    '# validate re-checks every file against the manifest and re-downloads what',
    '# does not match. That is what makes a reinstall a repair rather than a',
    '# gamble, and it is the whole update mechanism for this server.',
    './steamcmd.sh +force_install_dir /mnt/server +login anonymous \\',
    '  +app_update 4020 validate +quit',
    '',
    '# ---------------------------------------------------------------------',
    '# The Steam client library, and what it is really insuring against',
    '# ---------------------------------------------------------------------',
    '# This copy is a fallback that app 4020 does not reach, and the comment that',
    '# used to sit here claimed the opposite: that without it "the server starts',
    '# and runs and simply never completes the login". It was never true for this',
    '# game. Measured, with /mnt/server/.steam masked out entirely: the server',
    '# logs in anonymously, is assigned its gameserver Steam ID and turns VAC on,',
    '# exactly as with the copy in place.',
    '#',
    '# The reason is in the depot and in the wrapper. app 4020 ships its own',
    '# steamclient.so at the install root, 45 MiB of it, and srcds_run exports',
    '# LD_LIBRARY_PATH=".:bin:..." before exec-ing the binary, so SteamAPI_Init',
    '# finds that one first and says so: "Loaded local \'steamclient.so\' OK".',
    '#',
    '# The fallback is real, though, and that is why the copy stays. Masking the',
    '# depot\'s own copy makes srcds print "dlopen failed trying to load:',
    '# steamclient.so" and then "Loaded \'/home/container/.steam/sdk32/',
    "# steamclient.so' OK. (First tried local 'steamclient.so')\" — it logs in",
    '# either way. 47 MiB of the volume buys a login that cannot be lost to one',
    '# file at the root of the game tree, on the only game whose Steam login is',
    '# also its readiness marker.',
    '#',
    '# sdk64 is deliberately NOT written beside it. srcds_run picks its binary in',
    '# detectcpu(), which on Linux is "HL=./srcds_linux" with no 64-bit branch at',
    '# all, so the startup command in this template can only ever start the',
    '# 32-bit server — and the depot ships linux64/steamclient.so next to the',
    '# 64-bit binary for whoever starts that one directly. A second 44 MiB copy in',
    "# the operator's volume for a path nothing here takes is not insurance, it",
    '# is weight.',
    '#',
    '# HOME is /home/container in the runtime image, and the volume is mounted',
    '# there, so ~/.steam here is /mnt/server/.steam. That equivalence is the',
    '# reason the image pins HOME at all, and .github/workflows/source-image.yml',
    '# asserts it on every build.',
    'if [ ! -f "${STEAMCMD_DIR}/linux32/steamclient.so" ]; then',
    '  echo "SteamCMD left no linux32/steamclient.so to install." >&2',
    '  exit 1',
    'fi',
    '',
    '# The path written out rather than assembled, because this string is a',
    '# contract with the runtime image — where the volume is mounted, and what',
    '# HOME is set to — and a contract is worth being able to grep for.',
    'mkdir -p /mnt/server/.steam/sdk32',
    'cp -f "${STEAMCMD_DIR}/linux32/steamclient.so" /mnt/server/.steam/sdk32/steamclient.so',
    '',
    '# ---------------------------------------------------------------------',
    '# What the startup command is going to need',
    '# ---------------------------------------------------------------------',
    '# Checked rather than trusted, for the same reason Factorio checks for its',
    '# binary: set -e catches a steamcmd that failed, and cannot catch one that',
    '# succeeded somewhere other than where the startup command will look. This',
    '# is the only place those two paths can be compared, and they have to agree.',
    'cd /mnt/server',
    '',
    'if [ ! -x srcds_run ]; then',
    '  echo "SteamCMD reported success but left no executable srcds_run in" >&2',
    '  echo "/mnt/server. The startup command names ./srcds_run and would fail" >&2',
    '  echo "at the first start." >&2',
    '  exit 1',
    'fi',
    '',
    'if [ ! -d garrysmod ]; then',
    '  echo "SteamCMD reported success but left no garrysmod/ directory, which" >&2',
    '  echo "is what -game garrysmod names." >&2',
    '  exit 1',
    'fi',
    '',
    '# ---------------------------------------------------------------------',
    "# The operator's own files",
    '# ---------------------------------------------------------------------',
    '# Everything from here down runs only when it finds nothing worth keeping,',
    '# and that rule is what makes this script safe to run again. It has to be:',
    '# a reinstall is the only way to update a Steam server, so an operator who',
    '# keeps their server current runs this on a volume full of their work every',
    '# few weeks. app_update leaves files it does not own alone, so',
    '# garrysmod/addons, garrysmod/data and anything uploaded survive by',
    '# themselves; what needs the guard is anything this script writes.',
    '#',
    "# The published Garry's Mod egg gets this wrong in a way worth naming, since",
    '# it is the script most people arrive here having used: it truncates',
    '# garrysmod/cfg/server.cfg and garrysmod/lua/autorun/server/workshop.lua on',
    '# every run. Under a panel where reinstalling *is* updating, that silently',
    '# throws away the hostname, the password and every custom line the operator',
    '# has added, at the moment they were being careful.',
    'SERVER_CFG=garrysmod/cfg/server.cfg',
    '',
    '# "Has content", not "exists", and the difference is the whole guard. The',
    '# depot ships garrysmod/cfg/server.cfg itself — four bytes, CR LF CR LF —',
    '# so a test for the file alone matched on a *fresh* install and this block',
    '# never ran once: every server came up on an empty config, and the console',
    '# said it was keeping an existing file the operator had never written. grep',
    "# for one non-whitespace character is what tells the depot's placeholder",
    '# from a file somebody has edited.',
    '#',
    '# Seeding it is safe against the update path, which is the thing worth',
    '# checking before writing into a file the manifest owns: an edited',
    '# server.cfg was put through a full "+app_update 4020 validate" — 6.87 GB',
    '# re-verified, "Success! App \'4020\' fully installed" — and came back',
    '# untouched, as did a .cfg the depot has never heard of and a directory under',
    '# garrysmod/addons.',
    'if [ -f "${SERVER_CFG}" ] && grep -q "[^[:space:]]" "${SERVER_CFG}"; then',
    '  echo "Keeping the existing ${SERVER_CFG}."',
    'else',
    '  mkdir -p garrysmod/cfg',
    '',
    '  # A quoted heredoc: nothing in the body is expanded, so the file lands',
    '  # exactly as written even where it contains characters a shell would read.',
    '  cat > "${SERVER_CFG}" <<\'CFG\'',
    "// Garry's Mod server configuration.",
    '//',
    '// Hopper wrote this file during an installation that found nothing in it —',
    '// the game ships an empty one — and will not write over anything you put',
    '// here, not even the reinstall that updates the game. It is yours to edit.',
    '//',
    '// The gamemode, the map and the player limit are deliberately NOT here.',
    '// They are startup variables in the panel because they are command-line',
    '// arguments, and a command-line argument wins over this file at every',
    '// start — setting them here would look like it worked and change nothing.',
    '',
    'hostname "A Garry\'s Mod server"',
    'sv_password ""',
    '',
    '// RCON is not configured, and setting rcon_password here is a bigger',
    '// decision than it looks: it opens the remote console on the TCP half of',
    "// this server's port, with the password in plain text in a file the file",
    '// manager displays. Hopper has nowhere to keep a secret yet, so it will not',
    '// invent one for you and will not pretend this line is harmless.',
    'CFG',
    '',
    '  echo "Seeded ${SERVER_CFG} with a hostname you should change."',
    'fi',
    '',
    'echo "Garry\'s Mod installed."',
    'echo "Update it by reinstalling: that re-runs app_update 4020 validate,"',
    'echo "which repairs the game files and leaves garrysmod/addons,"',
    'echo "garrysmod/cfg and garrysmod/data untouched."',
    'echo ""',
    'echo "Gamemode, map and player limit are on the Startup page. Everything"',
    'echo "else — hostname, password, sandbox limits — is ${SERVER_CFG}."',
    'echo ""',
    'echo "This server has no Workshop collection, no Steam game-server login"',
    'echo "token and no RCON: all three need a credential the panel cannot yet"',
    'echo "store out of sight. It logs in to Steam anonymously, which works."',
  ].join('\n'),

  /**
   * Steam's rule of thumb applied to a measured tree, and the arithmetic is
   * written out because the figure it replaces did not do it.
   *
   * The installed tree is **6 919 647 587 bytes**, 6.44 GiB, by `du -sb
   * --apparent-size` over 2 352 files immediately after an install of app 4020
   * that this repository ran, before any server had started. What the preflight
   * has to survive is the middle of the download rather than the end of it:
   * SteamCMD stages a depot into `steamapps/downloading` **inside**
   * `+force_install_dir`, so the chunks and the files they become occupy the same
   * volume at once, and Steam's own rule of thumb for an install or an update is
   * twice the unpacked size. Twice 6.44 GiB is 12.89, so the figure is thirteen.
   * It used to be twelve, described as that doubling, which it is not — 12 GiB is
   * 1.86× and would have been under the rule it cited.
   *
   * An earlier draft of this comment said 6 966 171 222 bytes. That was the same
   * tree plus `.steam/sdk64/steamclient.so`, 46 MiB the install script no longer
   * writes; the figure below does not change, because thirteen clears twice
   * either number.
   *
   * The peak itself was **not measured**: nothing sampled the volume during the
   * transfer, so this is a rule of thumb over a measured tree and not an
   * observed high-water mark. Declaring the 6.49 that remain would be declaring
   * a figure that is true at exactly the moment it stops mattering, and the
   * punishment for being under is not this server failing — it is the node's
   * disk filling, which takes down every server on the machine.
   *
   * A reinstall is not refused by this figure on a node that is already carrying
   * the server: the preflight counts what the volume already holds towards the
   * requirement, because nothing wipes it first.
   *
   * `installInactivityTimeoutMs` is deliberately not declared beside it. The
   * daemon's default is fifteen minutes of the container doing *nothing at all*
   * — no output, no CPU, no block I/O — and no phase of a depot install is still
   * by that measure: downloading burns CPU on every packet taken off the socket,
   * validating hashes six and a half gigabytes off the disk, and both write
   * constantly. An hour-long download is not an idle one, which is the entire
   * reason that deadline was built on activity rather than on duration.
   */
  installRequiredDiskBytes: 13 * 1024 ** 3,

  /**
   * All three are `required` with a non-empty default, and that is a rule here
   * rather than a preference. Each one stands alone in an argument behind a flag
   * that needs it, and the invocation builder drops an argument whose variables
   * all resolved to nothing — leaving `+map` to swallow whatever came next.
   * `required` is what stops a user emptying the field; a non-empty default is
   * what stops a server created before anybody opened the Startup page from
   * starting on a command one argument short.
   *
   * All three are also `userEditable`, which is the exception rather than the
   * default in this schema: they are what an operator changes about a Garry's
   * Mod server, and a template nobody can configure is not worth shipping. Every
   * one of them is therefore narrowed to something that cannot be anything but
   * what it claims to be.
   *
   * The names are the ones the published Pterodactyl egg uses, so that an
   * operator moving a server across finds the fields they already know.
   */
  variables: [
    {
      name: 'Map',
      description:
        'The map the server starts on, without the .bsp extension. gm_construct and gm_flatgrass ship with the game; anything else has to be in garrysmod/maps first.',
      envVariable: 'SRCDS_MAP',
      defaultValue: 'gm_construct',
      userViewable: true,
      userEditable: true,
      /**
       * Narrowed because this value is both an argv token and a **path**: the
       * engine turns it into `garrysmod/maps/<value>.bsp`. The character class
       * is what keeps a `/` or a `..` out of that path, and excluding the dot in
       * particular means the value cannot be `..` and cannot name a file whose
       * extension somebody else chose.
       *
       * The length lives inside the expression rather than in a `max:` rule, for
       * the reason Factorio's save name records: `max:` compares anything that
       * parses as a number by its value, so `max:64` would refuse a map called
       * `2024` with a message about a number being too large.
       */
      rules: 'required|string|regex:/^[A-Za-z0-9_-]{1,64}$/',
    },
    {
      name: 'Gamemode',
      description:
        'The gamemode folder name under garrysmod/gamemodes — sandbox ships with the game. A gamemode has to be installed before it can be started.',
      envVariable: 'GAMEMODE',
      defaultValue: 'sandbox',
      userViewable: true,
      userEditable: true,
      /**
       * A directory name under `garrysmod/gamemodes`, so the same reasoning as
       * the map above: no separator, no dot, nothing that can leave the
       * directory it names. Upper case is admitted because a gamemode's folder
       * is whatever its author named it and this template is in no position to
       * refuse `DarkRP`.
       */
      rules: 'required|string|regex:/^[A-Za-z0-9_-]{1,32}$/',
    },
    {
      name: 'Player limit',
      description:
        'Player slots, 1 to 128. The engine allocates them at start, so raising it needs a restart — and each slot costs memory whether or not anybody is in it.',
      envVariable: 'MAX_PLAYERS',
      defaultValue: '16',
      userViewable: true,
      userEditable: true,
      /**
       * Two rules doing two different jobs, and both are needed.
       *
       * `integer|min:1|max:128` bounds the *value*: 128 is the engine's own
       * ceiling. The expression bounds the *spelling*, and that is the half that
       * matters here — `integer` is satisfied by anything `Number()` reads as a
       * whole number, so `1e2`, ` 20 ` and `20.0` all pass it, and each of them
       * would then be handed to the engine as an argv token for its own parser
       * to make what it liked of. Digits only removes the question.
       *
       * The expression is last because the panel scans a delimited `regex:` to
       * its closing slash and reads the rules after it normally; this
       * catalogue's convention is to put it at the end regardless, and a test
       * enforces it.
       */
      rules: 'required|integer|min:1|max:128|regex:/^[0-9]{1,3}$/',
    },
  ],
};

export const SOURCE_TEMPLATES: TemplateDefinition[] = [garrysMod];
