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

The script asks four questions — domain, web server, certificate, administrator account — then
installs Node, Docker, PostgreSQL and Redis, builds the panel, writes the systemd services, declares
the local node and configures the vhost. Allow five to ten minutes, most of it the build.

At the end it prints the panel's address and the administrator's password, **which cannot be
recovered afterwards**.

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

| Variable                | Role                            | Default             |
| ----------------------- | ------------------------------- | ------------------- |
| `HOPPER_DOMAIN`         | Domain or IP of the panel       | host name           |
| `HOPPER_WEBSERVER`      | `nginx`, `apache` or `none`     | `nginx`             |
| `HOPPER_TLS`            | `yes` to request a certificate  | `yes` with a domain |
| `HOPPER_ADMIN_PASSWORD` | Password of the account created | generated           |
| `HOPPER_ROOT`           | Installation directory          | `/opt/hopper`       |
| `HOPPER_PORT`           | Port the panel listens on       | `8080`              |
| `HOPPER_DAEMON_PORT`    | Port the daemon listens on      | `8443`              |

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
3. Check from the panel: **Administration** has to show the node as reachable.

The daemon refuses to start if `/etc/hopper/daemon.yml` is readable by anyone other than root: it
holds the node secret and the console signing key.

## Uninstalling

```bash
systemctl disable --now hopper-panel hopperd
rm -f /etc/systemd/system/hopper-panel.service /etc/systemd/system/hopperd.service
rm -rf /opt/hopper /etc/hopper /usr/local/bin/hopper
su - postgres -c "dropdb hopper && dropuser hopper"
```

`/var/lib/hopper` holds **your servers' volumes and your backups**: these commands do not remove it,
and moving it is wiser than erasing it.
