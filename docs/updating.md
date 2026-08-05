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
