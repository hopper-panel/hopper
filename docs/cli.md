# Command line

`hopper` is installed into `/usr/local/bin` by the installer. In development, the same thing is
available from `apps/panel` with `pnpm cli <command>`.

The command reads the panel's `.env`: it therefore acts on the same database and under the same
rules as the interface — a password that is too short is refused here too.

## `hopper doctor`

A complete diagnostic of the installation. Its output distinguishes three levels: `✓` fine, `!` a
warning — it works but will bite later —, `✗` a failure. The exit code is 1 as soon as a `✗`
appears, which allows chaining it in a script.

What it checks:

- **System**: Node version, presence of cgroup v2's memory controller — without it, the RAM limits
  set on the containers are not enforced.
- **Configuration**: `APP_SECRET` left at its example value, a public URL on `localhost` while the
  panel is in production, absence of TLS.
- **Database**: connection, **pending migrations**, presence of at least one administrator.
- **Redis**: reachable, or absent — in which case rate limiting restarts from zero on every restart.
- **Nodes**: each node is genuinely queried. A declared node is not a reachable node. Each one that
  answers is also asked whether its servers are still isolated from one another — see
  [what that rests on](./security.md#what-hopper-already-protects). A node whose Docker network lets
  containers talk to each other is a `✗`; a daemon too old to be asked, or one whose Docker was not
  answering, is a `!`, because neither is evidence that anything is open.
- **Docker host**: socket reachable and engine version, if the machine hosts a daemon. A socket the
  panel is not allowed to open reads as healthy: the panel runs as `hopper`, and `hopperd` is what
  talks to Docker, as root.

## `hopper user:create`

```bash
hopper user:create --email me@example.com --username julien --admin
```

Creates an account. Without `--password`, a password is generated and shown **once only**. `--admin`
grants the administrator role.

## `hopper user:password`

```bash
hopper user:password --username julien
```

Changes the password and **closes every session** of the account: this is the command to run when
credentials are suspected stolen. Since SFTP uses the same credentials, it follows immediately.

## `hopper node:create`

```bash
hopper node:create --name paris-1 --fqdn node1.example.com --output /etc/hopper/daemon.yml
```

Declares a node and writes its configuration. Without `--output`, the `daemon.yml` goes to standard
output, which allows redirecting it or copying it to another machine.

Options: `--scheme http|https` (default `https`), `--port` (8443), `--sftp-port` (2022), `--memory`
and `--disk` in bytes — `0` meaning "no declared limit".

## `hopper node:token`

```bash
hopper node:token --node paris-1 --output /etc/hopper/daemon.yml
systemctl restart hopperd
```

Renews a node's token and regenerates its `daemon.yml`. This is the rescue command: it restores a
node whose configuration was lost, or whose secrets are no longer decryptable because `APP_SECRET`
changed.

**The previous token stops being valid immediately.** The node stays unreachable from the panel
until the file is in place and the service restarted; the servers already running keep running — it
is the control link that is cut, not the containers.

Without `--node`, the command refuses to act when several nodes exist rather than picking one:
rotating the wrong machine's token cuts a production off, and the mistake only shows at the next
restart.
