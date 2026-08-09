# Securing your instance

The [security policy](../SECURITY.md) describes the project's threat model and how to report a flaw.
This document addresses whoever **runs** an instance: what to set, back up and watch.

## The six things that matter

### 1. `APP_SECRET` — back it up, never change it

It encrypts the node tokens, the SQL servers' passwords and the two-factor secrets. Replacing it
makes all of them unreadable at once: the console errors with a 500, database servers become
unusable, 2FA sign-ins become impossible.

Back `apps/panel/.env` up **with** the database, not separately. A SQL dump without its secret
restores only half an instance.

### 2. The panel behind TLS

Without HTTPS the session cookie travels in the clear: stealing it is enough to take over every
server its owner holds. The installer lays down a Let's Encrypt certificate when a domain is given;
`hopper doctor` warns until that is the case.

### 3. `/etc/hopper/daemon.yml` in 0600

It holds the node secret and the console signing key. Whoever reads it can drive every server on the
machine. The daemon **refuses to start** if other users can read it — that is deliberate, do not work
around the check.

### 4. The firewall, in `DOCKER-USER`

Docker writes its `iptables` rules before ufw's. A ufw rule that seems to close a container's port
closes nothing:

```bash
iptables -I DOCKER-USER -p tcp --dport 25565 ! -s 203.0.113.0/24 -j DROP
```

Expose to the outside only the panel (80/443), the daemon (8443), SFTP (2022) and the game ports.
The database and Redis have no reason to be reachable.

### 5. Two-factor authentication for administrators

An administrator account can create a server, and therefore run code on the host. **My account →
Two-factor authentication**; it also protects SFTP, which shares the credentials.

Or a **passkey**, which is stronger and less work. The key lives in your phone, your laptop's
secure enclave or a USB key, and the private half never reaches the panel — there is nothing in the
database for a stolen dump to replay. It is registered and used with user verification required, so
the device asks for a PIN or a biometric every time: possession and knowledge both, before the
browser has said anything to us. That is why a passkey login asks for no code afterwards.

The signature covers the origin. A convincing copy of the sign-in page on another domain gets a
signature that verifies against that domain and nowhere else, so the phishing attempt that works
against a password and a code produces nothing usable here.

Two things to know before relying on one:

- **Passkeys need HTTPS.** Browsers refuse them over plain http, except on `localhost`. If `APP_URL`
  is not https, registration fails in the browser and the panel says so in its log at startup.
- **A device-bound passkey dies with the device.** The account page marks each one _synchronised_ or
  _this device only_. If your only passkey is the second kind, register another — your password
  still works, but a lost phone should not be the thing you find that out from.

### 6. Backups, off the machine

A backup on the same disk as the data protects only against human error: it survives a deleted
world, not a dead disk. Point the daemon's `system.backupDirectory` at another disk, and copy the
archives off the machine yourself — `rsync`, `restic`, whatever you already run.

There is no object-storage driver yet. An earlier version of this page said there was one, which
was worse than saying nothing: an operator who believed it would have found out when they needed
the backups.

## What Hopper already protects

You have nothing to set for the following — it is the default behaviour:

- **Unprivileged containers**: `cap_drop: ALL`, `no-new-privileges`, a pids limit, never
  `--privileged`, and the Docker socket is never mounted into a server container.
- **A path jail** on every file operation and on SFTP: the path resolved through `realpath`,
  symlinks leaving the volume refused, zip-slip protection on extraction.
- **Servers isolated from one another on the node**, except through their allocated ports. Each
  container is attached to a bridge of Hopper's own — `hopper0` by default, never Docker's `bridge`,
  where every container sees every other — and that bridge is created with
  `com.docker.network.bridge.enable_icc=false`, so the kernel drops every packet from one server's
  container to another's address — a server has no route to its neighbour at all. What arrives from
  outside the node is what Docker publishes for that server, which is exactly its allocations: every
  allocated port, TCP and UDP, on the address it was allocated on, and nothing besides. A port a
  plugin opens for itself and nobody allocated — an internal admin listener, a metrics endpoint, a
  database bound to localhost — is reachable from inside its own container, and no other server on
  the machine can reach it. RCON is not an example of this: Hopper models it as an allocation, so it
  is published like any other and reachable from outside the node. Bind it somewhere you trust, or
  allocate it on 127.0.0.1.

  **One condition, and it is measured rather than assumed.** That option can only be set when the
  network is created; Docker offers no way to change it afterwards. So a `hopper0` that already
  existed the first time hopperd ran — created by hand, by a Hopper predating the option, or
  restored with a machine image — keeps whatever it was created with, and on such a node the
  paragraph above is simply false. Hopper cannot repair it in place, so it checks instead: the
  daemon inspects the network at every start and again on every health check, writes the fault to
  its log with the commands that fix it, and `hopper doctor` reports it as a **failing check**
  against that node. A daemon that cannot reach Docker says so as "could not check" — never as
  "not isolated", which would send you to rebuild a network that was never the problem.

  Repairing it is left to you, on purpose, because recreating a network disconnects every container
  on the machine:

  ```bash
  # on the node, with its servers stopped
  docker network rm hopper0
  systemctl restart hopperd   # recreates it from daemon.yml, with the option set
  ```

  That second line rebuilds the network only if `docker.network.autoCreate` is true, which is the
  default. **If you set it false**, hopperd will refuse to start against a missing network instead
  of creating one — so recreate it yourself before restarting, and the daemon's own log prints the
  exact `docker network create` for your subnet. `hopper doctor` deliberately prints no commands for
  this check: it cannot see that setting, and the wrong half of the advice takes a node offline.

  The daemon does neither of the two things it could have done instead, and both were worse. Doing
  that recreation itself, at startup, would be an outage across every server on the node — caused by
  the daemon, unprompted, to close a hole between servers that were all running a second earlier —
  and Docker refuses to remove a network while anything is attached, so it would fail halfway on
  exactly the busy node where it matters. Refusing to start protects the isolation perfectly and
  takes the whole node down to do it: no console, no backups, nothing startable or stoppable, and no
  way to say why, since a daemon that has exited shows in the panel as a node that is offline —
  indistinguishable from a dead machine. The hole stays open and reported, because its blast radius
  is between the servers on one node while the blast radius of either cure is every server on it.

- **Two-part node tokens**: public identifier, secret encrypted in the database with `APP_SECRET`,
  rotation through `hopper node:token`. Encrypted rather than hashed, and the difference is worth
  knowing: a node token is not a password the panel only ever checks, it is a **shared secret used
  in both directions** — the daemon presents it to the panel on `/api/remote/*`, and the panel
  presents it right back to command the daemon. A hash cannot be presented, so the panel has to be
  able to read the value. It is protected by a key that lives in `.env` and never in the database,
  so a dump of the database on its own yields nothing usable. A dump that comes with `APP_SECRET`
  yields control of every node, which is why that file's permissions are the ones to guard.
- **Short-lived console JWTs**, carrying the bearer's permissions, verified by the daemon — which
  also checks the origin of the WebSocket connection. They are never issued to an API key: that
  route answers `403`. Read "short-lived" as the guarantee itself, and see
  [what a revocation does not reach](#what-hopper-does-not-protect-a-console-already-open).
- **Startup commands as templates**, never a concatenation handed to a shell.
- **A bounded install container**: the server's own memory limit, at least a whole core of CPU (its
  own entitlement where that is more), a pids limit of its own — 512, rather than the server's,
  since an operator who trimmed a small server's fork budget did not mean to forbid an unpacking
  that runs `xargs -P` — never privileged, and `no-new-privileges` so nothing it drops in the
  volume can gain more later. Docker's default capability set is dropped, and **seven are then
  handed back**: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `KILL`, `SETUID` and `SETGID`. So
  this container is deliberately **not** held as tightly as a server container, which keeps none of
  the fourteen and does not run as root; an install script is a package manager unpacking as root
  over a tree owned by the server's uid, which is precisely the work capabilities gate. What it
  does not get is the part that matters: `MKNOD`, `NET_RAW`, `SETFCAP` and `AUDIT_WRITE` are gone,
  so it cannot plant a device node in the volume, capture or forge frames on the bridge it shares
  with every other server, write file capabilities onto a binary it leaves behind, or reach the
  host's audit log. It is also the one container here whose environment a server's own user edits,
  which is why that list is worth reading twice.
- **Installations that end**: the node's free space is checked before one starts and a shortfall
  refused with both figures named — and with the filesystem they were read off named too, that
  being the one the volume lives on rather than, necessarily, the one carrying Docker's storage. An
  installation that stops making progress is torn down instead of holding a server in "installing"
  for ever. Progress means what the container _does_ — the CPU the kernel charges it and the blocks
  it reads and writes, both counted against its own cgroup, plus anything it prints — not whether
  it is talking, because `curl -sSL` prints nothing at all while it downloads. Its network counters
  are deliberately **not** watched: those count frames the interface accepted, including the
  broadcast traffic a Linux bridge floods to every port on it, so watching them would make a
  stalled install look busy on exactly the crowded nodes where one that never ends costs the most.
- **A Docker that stops answering fails loudly**, everywhere and by default. The daemon puts a
  deadline on every request it makes to the Docker socket — one rule at the client rather than a
  timer per call site, so a call added tomorrow is bounded without its author having to arrange it —
  and abandons a request nothing has answered, closing the socket behind it. This matters most in
  the install path, where `install` holds a server's operation queue: one unbounded round trip there
  costs that server every later start, stop and reinstall until the daemon is restarted, with
  nothing in the panel to say why.

  **Three things are deliberately outside it, and they are the same three every time.** The wait for
  a container to _end_, taken up below. The streams — a server's console, its statistics, a pull's
  progress — which are bounded up to the moment Docker hands them over and not one instant further,
  because a quiet Minecraft server sends nothing down its console for hours by construction. And the
  attach handshake, which is issued by hand rather than through the Docker library and so carries a
  clock of its own. A pull's progress stream has a second guard instead: it
  is abandoned when the registry stops sending, which is a bound on inactivity rather than duration,
  since Docker reports progress per chunk of every layer.

  **The wait is the one to be exact about**, being the single exemption to a rule whose whole value
  is that it has no others. The daemon asks it of two containers, both throwaway: the one that runs
  the install script, and the one that hands the installed files back to the server's user. Nothing
  waits that way on a **server** — a server's exit arrives as the end of its console stream, and its
  cause from an `inspect` after the fact — so the call a clock would bound is an installation's, and
  an install container still going after two hours is a Steam depot doing exactly what it was asked.
  A cap on total duration is the one thing the install deadline above was built not to be. Nor is
  the wait left unwatched for that: both call sites race it against that same deadline on activity,
  so a container that stops doing anything is torn down and the wait abandoned with it. It is
  bounded by progress rather than by the clock. The exemption itself is written against the
  endpoint, which names no container, so it would cover a wait on a server too if anything here ever
  asked for one — and that is the right way round, since bounding _that_ one really would report
  every long-running server as a crash.

  **Four failures are reported without failing an installation**, and it is worth knowing which.
  A failed ownership `chown`, because the files are already on the disk by then and the server may
  simply need a reinstall before it can write into its own volume — and that holds however it
  failed, a Docker that would not create or start the container it runs in included. A failed
  _removal_ of the install container, for the same reason arrived at from the other end — the
  installation worked, and what is left is a container on the node the console names so somebody
  can clear it. A failed removal of the container the `chown` ran in, which is that same fault one
  step later and is said as a line of its own rather than folded into the reclaim's verdict:
  overwriting that verdict would lose the reason the ownership was never taken, and this container
  is the one worth clearing first, since it still has the server's volume mounted. And a free-space
  check that could not be made at all: a `statfs` the node cannot answer says so and installs
  anyway, because refusing every installation on such a node would be a larger failure than the one
  being guarded against. Read the disk check as a check: see below for what it is not.

- **An audit log** of every sensitive action, readable per server.
- **Rate limiting** on authentication, on 2FA and on SFTP.
- **Refresh tokens rotate on every use**, and each is kept, revoked, after the rotation that
  replaced it. A revoked token turning up again is how a stolen session is caught: the whole family
  is revoked, which signs out the thief and the legitimate user together, and an
  `auth.token.reuse-detected` entry says when.

  **Except within thirty seconds of the rotation, on a family that is still signed in.** That is a
  browser losing a race, not a theft, and treating the two alike made the panel unusable: the access
  cookie lasts exactly as long as the access token, so every tab of one browser loses it in the same
  second, each refreshes, and the one that arrives second is holding a token the first has just
  revoked. Every fifteen minutes, for anybody working with the panel open twice. Inside the window
  the replay rotates again instead. Outside it — or once the family has been signed out, which
  leaves nothing alive for the check to find — it still burns everything.

  The hole this leaves is exactly its width: a token stolen _and_ replayed within thirty seconds,
  while its owner is still signed in, is not caught. Nothing can tell that apart from the tab race —
  both are one token arriving twice, seconds apart, on a family in use.

## What Hopper does not protect: the disk an installation writes

**An install script can fill the node's disk, and nothing here stops it.** It runs as root with
`/mnt/server` bind-mounted from the host, and a bind mount carries no quota: `diskBytes` — the
server's disk limit — is the daemon's own accounting, applied to the file manager and to SFTP, and
the kernel knows nothing about it. A script that downloads two hundred gigabytes into `/mnt/server`
writes two hundred gigabytes, and a full node takes down every server on it, not only that one.

This matters more than it looks, because install scripts routinely download from a URL held in a
**template variable** — and template variables are what a server's own user edits from the startup
page, under the `startup.update` permission alone. So the reach is not "an operator wrote a careless
egg"; it is "anyone with a server on the node".

The free-space check that runs before an installation is a **preflight, not an enforcement**. It
refuses to start when the node is already short — which is the common accident, and worth refusing —
and then the script writes whatever it writes. There is deliberately no ceiling on `/tmp` either: one
was tried, and since the volume next to it has no ceiling it moved the problem rather than closing
it, while breaking every egg that stages a download in `/tmp`.

A real quota is a **node-provisioning feature, and it does not exist yet** — an XFS project quota
per volume, or a loopback image per server, both decided when the node's storage is laid out rather
than by the panel. Until it does, an operator who wants a bound has one: put `system.dataDirectory`
on a filesystem of its own, so a runaway install fills that filesystem and not the one carrying
Docker's data root, the database and the daemon's logs. Watch its free space like any other.

That bounds the common shape and not every shape, which is worth knowing before relying on it: a
script that stages its download in `/tmp` writes to the container's own layer, under Docker's data
root, and so lands on the filesystem the split was meant to protect. It is also the filesystem the
preflight above does **not** measure — that one reads the volume's, and says so when it refuses.

## What Hopper does not protect: a console already open

**Revoking an access does not close a console that is already connected.** It closes the next one.

The console is the one place a browser talks straight to the daemon, and the daemon verifies the
token on its own — no call back to the panel, which is what lets fifty consoles cost the panel
nothing. The consequence is exact: nothing the panel does reaches a console mid-session. Signing
out, changing a password, suspending an account, deleting a subuser, taking a permission away — all
of them take effect at the **next renewal**, which is an ordinary
authenticated request to the panel and is refused like any other. Until then the connection stays
up, with the permissions frozen into the token rather than the current ones.

**That window is two minutes**, the token's whole lifetime. It is deliberately short because it is
the only bound there is: the token carries no session identifier, and there is no channel by which
the panel could tell a daemon to drop a session. The token does carry a unique identifier, but
nothing anywhere reads it — it is not a handle you can revoke one console by.

To cut live consoles on a node **now** rather than within two minutes, re-key it — the procedure
below does exactly that, because it replaces the secret those tokens are signed with. Legitimate
users reconnect on their own within seconds; a revoked one cannot, having nothing left to obtain a
new token with.

Three neighbours of this, worth knowing while you are here:

- **An SFTP session already open is the same shape of hole, without the two minutes.** The daemon
  asks the panel to authenticate an SFTP connection once, when it opens, and applies the permissions
  it got back for as long as the session lasts. `systemctl restart hopperd` is what ends one; the
  client's automatic reconnect then goes back through the panel and is refused.
- **There are no signed download URLs.** The panel can mint and verify them — the code is there,
  and the contract calls them single-use, which they are not — but nothing in the product issues
  one. Every download goes through an authenticated call instead. Said here because the machinery
  is visible to anyone reading the source, and an unused mechanism described as a protection is a
  protection somebody will count on.
- **The file manager is not affected.** Every one of its operations is an authenticated call to the
  panel, so a revocation bites there at once.

## After an incident

If you suspect credentials were stolen:

```bash
hopper user:password --username <account>   # also closes every session
hopper node:token --node <node>             # new daemon token *and* new console signing key
# put the printed daemon.yml on the node, then:
systemctl restart hopperd
```

The middle command is the one that reaches consoles already open: it re-keys the node, so every
console token issued before it becomes unverifiable the moment the daemon restarts. Without it,
count on the two minutes described above.

Then read back the activity log of each affected server — it carries the IP address and the author
of every action — and change the passwords of the databases created from the panel.
