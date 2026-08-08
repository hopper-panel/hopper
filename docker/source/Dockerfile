# syntax=docker/dockerfile:1

# `ghcr.io/hopper-panel/source` — the runtime image the Source templates name.
#
# It is a 32-bit runtime and nothing else. No SteamCMD, no compiler, no
# entrypoint script: the game arrives in the volume, put there by a throwaway
# install container running `debian:bookworm-slim`
# (`packages/templates/src/catalog/source.ts`), and all this image contributes
# is the handful of shared libraries that tree turns out to name.
#
# **Built here rather than borrowed**, which is the decision this file exists to
# justify. `Server.dockerImage` is copied onto the server row at creation, so
# the string a template ships with on day one outlives every later edit of that
# template and cannot be renamed for the servers already carrying it. A name
# this project does not control is therefore not a dependency that could be
# swapped later — it is a permanent one, on somebody else's retention policy.
#
# ---------------------------------------------------------------------------
# The library list was measured, and every claim below is a measurement
# ---------------------------------------------------------------------------
# The template's own install script was run against `debian:bookworm-slim` with
# the install container's capability set; `+app_update 4020 validate` left
# 6.5 GB in the volume. Every regular file in it was classified with `file` and
# read with `readelf -d`: 43 ELF objects, 39 of them 32-bit, only three of them
# anything other than a shared library (`srcds_linux`, `gmad_linux`,
# `gmpublish_linux`), and exactly three program interpreters among the lot —
# every one of them `/lib/ld-linux.so.2`.
#
# The census was taken twice and the first count said 44. The extra object was
# `.steam/sdk64/steamclient.so`, a copy the install script used to write and no
# longer does — `srcds_run`'s `detectcpu()` has no 64-bit branch, so nothing
# could ever have loaded it. The figures here are from a tree the current
# script produces, which is the only tree this image will ever be handed.
#
# Then the server was started on this image, and `/proc/<pid>/maps` was read
# while it sat there with both readiness markers printed. It had mapped exactly
# eight files that did not come out of the volume:
#
#     ld-linux.so.2  libc.so.6  libdl.so.2   libgcc_s.so.1
#     libm.so.6      librt.so.1 libpthread.so.0            libstdc++.so.6
#
# Three packages provide all eight. The ninth thing it turned out to need is not
# a library at all; see `ca-certificates` below, where the failure is quoted.
# What is *not* installed is the longer and more useful half of the finding, and
# it is written out under the `RUN`.

# Debian, and the same release as the install container.
#
# The two containers write and read one volume, so the fewer differences between
# them the better: with both on bookworm there is no second glibc anywhere in
# the story, and nothing to reason about the day one of them moves.
#
# A floating tag rather than a digest, deliberately. The workflow beside this
# file can be dispatched by hand precisely so that a base-image security fix
# ships without waiting for a Hopper release, and a pinned digest would turn
# that dispatch into a no-op until somebody remembered to edit this line.
FROM debian:bookworm-slim

# One `RUN`, because three would be three layers carrying three copies of the
# apt lists. `DEBIAN_FRONTEND` is set for this command alone and not as an
# `ENV`: it is an instruction to apt, and leaving it in the image's environment
# would hand it to every game server that ever starts here.
RUN dpkg --add-architecture i386 \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    # /lib/ld-linux.so.2 — the 32-bit loader, without which `srcds_linux` does
    # not exec at all — and libc.so.6, libdl.so.2, libm.so.6, libpthread.so.0
    # and librt.so.1 with it. Six of the eight the running server mapped.
    libc6:i386 \
    # libstdc++.so.6, named by 27 of the 39 32-bit objects — the engine, the
    # Garry's Mod server module and tier0 among them.
    libstdc++6:i386 \
    # libgcc_s.so.1, the eighth. `libstdc++6:i386` depends on it, so this line
    # changes nothing about what gets installed; it is here because the running
    # server maps it, and a soname that is needed should be asked for rather
    # than arrive as somebody else's dependency.
    libgcc-s1:i386 \
    # **Not optional, and this one was watched failing.** Built without it, the
    # server reaches "logging into anonymous game server account" and then
    # steamclient.so prints, four times over,
    #
    #     src/common/opensslconnection.cpp (1636) : unable to load trusted SSL
    #     root certificates
    #
    # and stops there: no "Connection to Steam servers successful", no Steam ID,
    # no VAC line — so neither readiness pattern is ever printed and the start
    # fails at the ten-minute deadline on a server that is otherwise up. All
    # four copies of steamclient.so in the depot name
    # `/etc/ssl/certs/ca-certificates.crt` in their string tables, beside
    # `/etc/pki/tls/cert.pem` and `/etc/ssl/ca-bundle.pem`; a slim Debian has
    # none of the three.
    ca-certificates \
    # The daemon passes `TZ` to every container it creates
    # (`apps/daemon/src/docker/container-config.ts`). Without the zone files
    # glibc answers UTC to any value at all, and every timestamp in the console
    # is silently hours out of step with the panel around it.
    tzdata \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# What is deliberately absent, and why
# ---------------------------------------------------------------------------
# Every one of these was in an earlier draft of the build's assertions. All of
# them were measured out of it.
#
#  • **libcurl.so.4 and libcurl-gnutls.so.4.** Neither appears in a single
#    `NEEDED` entry anywhere in the tree, and neither appears in any object's
#    string table either — so nothing can be `dlopen`ing one under a name this
#    image could satisfy. Garry's Mod reaches the network through
#    `steamclient.so`, which brings its own HTTP with it.
#
#  • **libSDL2-2.0.so.0, libtcmalloc_minimal.so.4, libudev.so.0, libbass.so,
#    libcrypto.so.1.0.0 and libssl.so.1.0.0.** All six are named, and all six
#    are shipped by the game in `bin/`: `srcds_run` begins with
#    `export LD_LIBRARY_PATH=".:bin:$LD_LIBRARY_PATH"`, and the running server's
#    maps show tcmalloc resolved to `/home/container/bin/`. tcmalloc is the one
#    that would be missed first — it is the very first `NEEDED` of `srcds_linux`
#    itself — and installing Debian's copy over the top would substitute an
#    allocator Valve never tested for the one they did, to fix nothing.
#
#  • **libz.so.1, and the GTK 2, X11, NSS, CUPS, ALSA, libpng12 and libgcrypt11
#    set beside it.** Every one of those sonames comes from a single file,
#    `bin/libawesomium-1-7.so.5.0` — the embedded Chromium behind Garry's Mod's
#    HTML panel, which is client-side. The running dedicated server does not map
#    it. It could not load it in any case: libpng12, libgcrypt11 and GConf left
#    Debian releases ago, so no bookworm image can satisfy that object however
#    many packages it installs.
#
#  • **The 64-bit half.** Four ELF64 objects are in the tree —
#    `linux64/steamclient.so`, `linux64/libsteamwebrtc.so` and
#    `bin/linux64/vphysics{,_srv}.so` — and not one of them is an executable:
#    every program interpreter in the depot is the 32-bit one, so app 4020's
#    default branch ships no 64-bit `srcds` and nothing in it can load them.
#    They want amd64 `libstdc++.so.6` and `libmvec.so.1`, neither of which is
#    installed here. A Source template that selects a 64-bit branch will need
#    both, and the assertions in the workflow are where it should say so.

# ---------------------------------------------------------------------------
# readline: the warning is kept, and the choice was measured both ways
# ---------------------------------------------------------------------------
# `bin/dedicated_srv.so` carries the strings `libtinfo.so.5` and
# `libncurses.so.5` and `dlopen`s one of them at start-up. Neither is here, so
# every server built from this image prints, once, before anything else:
#
#     WARNING: Failed to load 32-bit libtinfo.so.5 or libncurses.so.5.
#       Please install (lib32tinfo5 / ncurses-libs.i686 / equivalent) to enable
#       readline.
#
# **It is not that they are unavailable, and nobody should "fix" this believing
# they are.** Bookworm ships both — `libtinfo5:i386` and `libncurses5:i386`,
# version 6.4-4, carrying `libtinfo.so.5.9` and `libncurses.so.5.9`. An image
# with them added was built and run: the warning goes, the server prints both
# readiness markers exactly as before, `quit` down the attach stream still exits
# 0 within a second, and the console stream gains no escape sequences and no
# redrawn prompt. It costs 0.3 MB. Nothing breaks either way.
#
# They are left out because of what readline is *for*. It is a line editor for a
# human at a terminal, and there is no human at this terminal: Hopper's console
# is a browser talking to the daemon over a WebSocket, the editing happens
# there, and what arrives here is a finished line down the attach stream. So the
# two packages would buy the removal of one line of text, in exchange for
# depending on Debian's ncurses ABI 5 compatibility set — packages that exist to
# keep a retired soname alive, and whose eventual removal would break this build
# over that same line of text.
#
# Leaving the warning also leaves it honest: it says readline is off, and
# readline is off.

# ---------------------------------------------------------------------------
# The contract with the daemon
# ---------------------------------------------------------------------------

# `HOME`, and it is the one environment variable that has to be in the image.
#
# The daemon builds a container's `Env` from the template's variables and its
# own built-ins (`buildEnvironment`, `apps/daemon/src/server/invocation.ts`);
# `HOME` is not among them and is not going to be, since the volume is mounted
# at a fixed path and there is nothing per-server to say. Docker's fallback is
# the home directory in `/etc/passwd` for the container's user — and the daemon
# runs the server as a numeric uid it chose on the node, which has no passwd
# entry in this image or any other. The fallback is `/`.
#
# What that costs was measured rather than assumed, and it is worth knowing in
# both halves. With the depot as SteamCMD leaves it, nothing: the engine finds
# the `steamclient.so` sitting in the game root — `LD_LIBRARY_PATH` starts with
# `.` — and logs in under `HOME=/` perfectly well. What `HOME` decides is the
# **fallback**, and the fallback is the one the install script provisions. Hide
# the game-root copy and the difference is total:
#
#     HOME=/                 [S_API] SteamAPI_Init(): Sys_LoadModule failed to
#                            load: //.steam/sdk32/steamclient.so
#                            → no login, no readiness marker, start times out
#     HOME=/home/container   → logs in, both markers printed
#
# That doubled slash is the mechanism in plain sight: the path is `$HOME` with
# `/.steam/sdk32/steamclient.so` appended, and this line is what makes it land
# on the copy the install script wrote into the volume. The failure it prevents
# is the expensive shape — a server that starts, listens, and simply never logs
# in, so it has no VAC, appears in no server browser, and is failed at the
# readiness deadline with nothing in the console that looks like an error.
#
# `HOME` is also where the Steam client library keeps its own writable state: a
# running server holds `Steam/logs/connection_log.txt` and a dozen like it open
# under this path, which means inside the operator's volume where they can read
# them, rather than attempted against a root-owned `/` and silently abandoned.
ENV HOME=/home/container

# The volume's mount point, created here so that it exists in the image itself.
#
# This is *not* what puts a server in its volume: the daemon sets `WorkingDir`
# on the container it creates and bind-mounts the volume over this path. The
# directory is here so the image is coherent on its own — `$HOME` naming
# somewhere that does not exist is the kind of detail that is harmless until
# somebody runs the image by hand to work out what a server is doing.
WORKDIR /home/container

# **No command, and clearing it takes a line.**
#
# `debian:bookworm-slim` sets `CMD ["bash"]` and an image inherits its parent's,
# so saying nothing here would ship a command rather than none. `CMD []` under
# BuildKit writes a null `Config.Cmd` — verified against the built image, and
# asserted on every build by `.github/workflows/source-image.yml` — which makes
# `docker run` with no arguments refuse instead of dropping into a shell.
#
# The daemon always sets `Cmd` from the template's startup command, so an
# inherited `bash` would in practice be overwritten rather than obeyed. The
# reason to clear it anyway is that this image should not carry an opinion it
# does not hold: an image whose default is `bash` is one somebody eventually
# starts by hand and believes they have started a server.
CMD []

# **No `ENTRYPOINT`, and none inherited** — this is the one that would break a
# server rather than merely mislead. The daemon sets `Cmd` and never
# `Entrypoint`, so an entrypoint here would not be replaced by the startup
# command, it would *swallow* it: `./srcds_run -game garrysmod …` would arrive
# as arguments to somebody else's script. The server would start wrong instead
# of failing to start, which is the shape of bug that takes a day to find.
#
# **No `USER`.** The daemon sets one on the server container, so nothing written
# here would survive; what this image must not do is state which uid owns the
# volume, because that uid is the node's to choose. The workflow asserts it, and
# says there what it would cost to be wrong.
