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
