# Installation

## What you need

- A **Debian 12+, Ubuntu 22.04+, Rocky or AlmaLinux 9+** machine, freshly installed for preference,
  with root access.
- **2 GB of RAM at minimum** for the panel and one Minecraft server. Count your servers' memory on
  top: a modern Paper asks for 2 to 4 GB on its own.
- A **domain name** already pointing at the machine if you want HTTPS. Without a domain, installing
  over HTTP on an IP address remains possible.
- Ports **80**, **443**, **8443** (daemon) and **2022** (SFTP) reachable from outside, plus those of
  your Minecraft servers.

A virtual machine at any host will do, on one condition: Docker containers have to be able to run.
**OpenVZ** and **LXC** VPSs generally do not allow it.

## Installation

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
sudo bash install/install.sh
```

The script asks everything it needs **before it writes anything**: the address, the web server, the
certificate, the administrator account, the name and language of the panel and the timezone the game
servers run in. It then shows what it is about to do and waits for one confirmation. After that it
installs Node, Docker, PostgreSQL and Redis, builds the panel, writes the systemd services, declares
the local node and configures the vhost, with nothing further to answer. Allow five to ten minutes,
most of it the build.

At the end it prints the panel's address and the administrator's password, **which cannot be
recovered afterwards**.

To see the answers without installing anything:

```bash
sudo bash install/install.sh --check
```

It asks the same questions, prints the same recap and stops before touching the machine.

### Rerunning it

The script is also the updater, and a rerun asks every question again with **the current answer as
the default** — so pressing Enter through it changes nothing. Change one answer and it moves: the
address is written into `.env`, into the vhost and into the node the panel calls, all three, which
is what makes reinstalling onto a new address actually work.

### Without interaction

Every answer can come from the environment, which allows installing from a deployment tool:

```bash
sudo HOPPER_NONINTERACTIVE=1 \
     HOPPER_DOMAIN=panel.example.com \
     HOPPER_WEBSERVER=nginx \
     HOPPER_TLS=yes \
     HOPPER_ADMIN_EMAIL=me@example.com \
     HOPPER_ADMIN_USERNAME=me \
     bash install/install.sh
```

| Variable                   | Role                                  | Default             |
| -------------------------- | ------------------------------------- | ------------------- |
| `HOPPER_DOMAIN`            | Domain or IP of the panel             | host name           |
| `HOPPER_WEBSERVER`         | `nginx`, `apache` or `none`           | `nginx`             |
| `HOPPER_TLS`               | `yes` to request a certificate        | `yes` with a domain |
| `HOPPER_ADMIN_PASSWORD`    | Password of the account created       | generated           |
| `HOPPER_PANEL_NAME`        | Name shown in the interface           | `Hopper`            |
| `HOPPER_LOCALE`            | `en`, `fr`, `es`, `de`, `ru`          | `en`                |
| `HOPPER_TIMEZONE`          | Timezone of the game servers          | this machine's      |
| `HOPPER_SET_HOST_TIMEZONE` | `yes` to move the machine's clock too | asked               |
| `HOPPER_ROOT`              | Installation directory                | `/opt/hopper`       |
| `HOPPER_PORT`              | Port the panel listens on             | `8080`              |
| `HOPPER_DAEMON_PORT`       | Port the daemon listens on            | `8443`              |

### Language and timezone

The language is the one served to anyone who has not chosen their own; every account can pick
another from its own settings.

The timezone is the one **the game servers** run in — it reaches every container as `TZ`, and it is
what stamps the time on each line of a server's log. It is asked separately from the machine's own
clock, which the script offers to align but never changes without being told to. Changing it later
is a field on the node, in the administration.

### Without a web server

`HOPPER_WEBSERVER=none` makes the panel listen directly on `0.0.0.0:8080`, with no proxy and no TLS.
Handy on a local network; to be avoided on the internet, where sessions would travel in the clear.

## After the installation

```bash
hopper doctor
```

The command checks the configuration, the database, Redis, the nodes and Docker. It is the first
reflex in front of any odd behaviour — see [the CLI documentation](./cli.md).

Then, in the interface:

1. **Administration → Nodes → your node → Allocations**: declare the ports your servers will be able
   to use, for instance the range `25565-25580`.
2. **Administration → Templates**: the shipped catalogue (Paper, Purpur, Vanilla, Fabric, NeoForge,
   Velocity, BungeeCord…) is already installed. Resynchronise after every Hopper update.
3. **Create a server**.

## Firewall

Docker writes its own `iptables` rules, **before** ufw's: a ufw rule that seems to close a container
port closes nothing at all. Filter in the `DOCKER-USER` chain:

```bash
# Only allow a server's port from a given network
iptables -I DOCKER-USER -p tcp --dport 25565 ! -s 203.0.113.0/24 -j DROP
```

On Rocky and Alma, `firewalld` is active and the installer opens ports 80, 443, 8443 and 2022 in it.
The ports of your Minecraft servers still have to be opened.

## Adding a second machine

The panel drives as many machines as needed. On the new one:

1. In the interface: **Administration → Nodes → Create**. The panel shows a `daemon.yml`.
2. On the host machine: install Docker and Node 22, copy the repository into `/opt/hopper`, build the
   daemon (`pnpm --filter @hopper/daemon build`), write the `daemon.yml` into
   `/etc/hopper/daemon.yml` in mode `600`, install `install/hopperd.service`, then
   `systemctl enable --now hopperd`.

   **For a node on the machine the panel already runs on**, press **Apply on this machine** instead:
   the panel asks a root-owned systemd unit to write the file in mode `600` and restart hopperd, and
   nothing has to be copied. It is offered only where that unit exists, which `install.sh` lays
   down; elsewhere the panel says so and gives the two commands to run.

3. Check from the panel: **Administration** has to show the node as reachable.

The daemon refuses to start if `/etc/hopper/daemon.yml` is readable by anyone other than root: it
holds the node secret and the console signing key.

## Uninstalling

```bash
sudo bash /opt/hopper/install/uninstall.sh
```

It removes what the installer created — the four systemd units, the `hopper` command, `/opt/hopper`,
`/etc/hopper`, the database and its role, the game containers, their Docker network, the vhost, the
certbot renewal hook and the `hopper` system user — and asks you to type `uninstall` first.

**Your servers' files are kept.** `/var/lib/hopper/volumes` holds every world, plugin and
configuration file, and that is the one part nobody can regenerate; the script says how much is
there and where. Add `--purge` to delete it as well, and the confirmation then asks you to type the
number of servers you are destroying rather than a word.

`--dry-run` prints what would go and touches nothing. It is worth a minute before the real thing,
especially on a machine that hosts something else.

This page used to list the commands to run by hand, and they were incomplete: they left behind the
two `hopper-update` units, the containers, the `hopper0` network, the vhost and the system user. The
script exists because that list was wrong in a way nobody notices — everything appears to have gone.

**Docker, PostgreSQL, Redis, nginx and certbot are left installed**, along with your TLS
certificates. They are shared services, another application may be using any of them, and deleting a
certificate would burn a Let's Encrypt rate limit for a domain you may want to reinstall on
tomorrow.
