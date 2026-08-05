# Updating

## In one command

```bash
sudo bash /opt/hopper/install/install.sh
```

Rerunning the installer on an existing installation updates the code and the database schema, and
touches neither the `.env`, nor the `daemon.yml`, nor the vhosts, nor the administrator account. The
services are restarted at the end.

## By hand

```bash
cd /opt/hopper
git pull
pnpm install --frozen-lockfile
pnpm --filter @hopper/shared build
pnpm --filter @hopper/panel exec prisma generate
pnpm --filter @hopper/panel exec prisma migrate deploy
pnpm --filter @hopper/panel build
pnpm --filter @hopper/web build
pnpm --filter @hopper/daemon build
chown -R hopper:hopper /opt/hopper
systemctl restart hopper-panel hopperd
hopper doctor
```

The order matters: `prisma generate` before building the panel, `migrate deploy` before the restart.
A panel starting on an unmigrated schema fails on its first request, not at launch — the failure
then shows up as an apparently unrelated 500.

## Downtime

Restarting the panel cuts the interface for a handful of seconds. Restarting the daemon **does not
stop the servers**: the containers keep running, only the open consoles reconnect. A server
therefore stays reachable by its players throughout the update.

## Before a major version bump

Back up these three things — all three, not two:

```bash
pg_dump -U hopper hopper > hopper-$(date +%F).sql   # the database
cp /opt/hopper/apps/panel/.env  ./env-hopper.bak    # APP_SECRET
cp /etc/hopper/daemon.yml       ./daemon.bak        # the node token
```

`APP_SECRET` encrypts the node tokens, the SQL servers' passwords and the two-factor secrets. **A
database restored without its original `.env` is unusable**: the panel will answer 500 on the
console, on testing a database server and on any 2FA sign-in. If that happens to you,
`hopper node:token` regenerates the nodes' secrets; the SQL passwords, however, are lost and the
databases have to be declared again.

## Rolling back

```bash
cd /opt/hopper
git checkout <previous-version>
pnpm install --frozen-lockfile && pnpm build
systemctl restart hopper-panel hopperd
```

Prisma migrations do not undo themselves: going back to a version older than the schema in place can
fail. Restore the database at the same time if the target version predates a migration.

## From the administration

Admin → Overview shows the installed version, the latest published one, and an
**Update now** button when the two differ.

The panel does not perform the update itself, and cannot. It runs under an
unprivileged account whose systemd unit sets `ProtectSystem=strict`, so writing
into `/opt/hopper` and restarting services is beyond it — deliberately.

What the button does is create one empty file in `/var/lib/hopper/updates`, the
single directory the panel may write to. A root-owned path unit,
`hopper-update.path`, reacts to that file and starts `hopper-update.service`,
which pulls and reruns the installer. The panel cannot say _what_ to run: no
command, no argument and no shell reach the root side. Someone who took over the
panel would gain "trigger the updater", not "run anything as root" — which is
what a sudoers rule would have given them.

The panel restarts in the middle of its own update, so the page loses its
connection and comes back. That is expected; it is not a failure. A failure
leaves its reason in the card, and in full under:

```bash
journalctl -u hopper-update -f
```

An installation made before this existed has no `hopper-update.path`. The card
says so rather than offering a button that would do nothing — rerun `install.sh`
once by hand and it appears.

## Versions

Hopper is versioned with semver, and the version lives in three places that have
to agree: every `package.json`, the `PANEL_VERSION` and `DAEMON_VERSION`
constants, and a git tag `vX.Y.Z`.

The administration compares its own constant against the **latest published
release** on GitHub — not against the tag list, and not against the branch. A
build claiming a version it is not would tell an operator they are current when
they are not, which is the one failure this check exists to prevent.

Cutting a release:

```bash
node scripts/release.mjs 0.2.0
git commit -am "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --follow-tags
```

Then publish a release for that tag on GitHub. The script refuses to run on a
dirty tree: a tag pointing at a commit that does not contain what was published
is a release nobody can reproduce.

The updater follows the latest tag when one exists, and `main` otherwise — so
what it installs is the version the administration just offered.

## Moving a server to another node

**Administration → Servers → _the server_ → Manage → Move to another node.**

Pick the destination and the panel says what it would cost before anything happens: how many free
ports that node has, and which databases would stay behind. Then type the server's name to confirm.

What happens, in order:

1. The server is **stopped**, and the panel waits until it really has stopped. Archiving a running
   world copies region files mid-write; what arrives on the other side would load with holes in it.
   If the server ignores the stop for two minutes the transfer is abandoned rather than forced —
   killing it there would produce exactly that damage.
2. Its files are compressed on the source node.
3. The archive is streamed **through the panel** to the target. No node ever talks to another node:
   a daemon that could be told "fetch this URL" would be a request forger sitting inside your
   private network. The bytes are relayed, never held in memory, so the panel's memory does not
   grow with the size of the world.
4. The archive is extracted on the target, and a free port there is assigned.
5. Only then is the old copy deleted.

A failure at any step before the last leaves the server exactly where it was, files intact — start
it again in place. If the move succeeds but the old copy cannot be removed, the transfer still
counts as done and the leftover volume is logged; the server is already running on the target, and
undoing a completed move to satisfy a cleanup would be the worse outcome.

Two things do not follow the server:

- **Its address.** The port comes from the destination node's pool, so players need the new one.
- **Databases on a host tied to the old node.** Their address is often reachable from that machine
  only. The panel names them before you confirm; move their contents yourself, or recreate them.

The server's identifier does not change, so backups, subusers, schedules and API keys all still
point at it.
