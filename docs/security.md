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
- **A device-bound passkey dies with the device.** The account page marks each one *synchronised* or
  *this device only*. If your only passkey is the second kind, register another — your password
  still works, but a lost phone should not be the thing you find that out from.

### 6. Backups, off the machine

A backup on the same disk as the data protects only against human error. Point the daemon's
`system.backupDirectory` at another disk, or use the S3 driver (MinIO, Backblaze, Wasabi) which
sends them elsewhere.

## What Hopper already protects

You have nothing to set for the following — it is the default behaviour:

- **Unprivileged containers**: `cap_drop: ALL`, `no-new-privileges`, a pids limit, never
  `--privileged`, and the Docker socket is never mounted into a server container.
- **A path jail** on every file operation and on SFTP: the path resolved through `realpath`,
  symlinks leaving the volume refused, zip-slip protection on extraction.
- **Two-part node tokens**: public identifier, secret hashed in the database, rotation through
  `hopper node:token`.
- **Short-lived console JWTs**, carrying the bearer's permissions, verified by the daemon — which
  also checks the origin of the WebSocket connection.
- **Startup commands as templates**, never a concatenation handed to a shell.
- **An audit log** of every sensitive action, readable per server.
- **Rate limiting** on authentication, on 2FA and on SFTP.

## After an incident

If you suspect credentials were stolen:

```bash
hopper user:password --username <account>   # also closes every session
hopper node:token --node <node>             # invalidates the daemon's token
systemctl restart hopperd
```

Then read back the activity log of each affected server — it carries the IP address and the author
of every action — and change the passwords of the databases created from the panel.
