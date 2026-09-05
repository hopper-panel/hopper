<div align="center">

# 🪣 Hopper Panel

**An open-source panel for hosting your game servers, on your own machine.**

Minecraft and its proxies, Factorio, the Source engine and Discord bots ship with it; anything else
runs through an imported Pterodactyl egg. Live console, file manager, SFTP, backups, scheduled tasks
— every server isolated in its own Docker container.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

</div>

---

> ⚠️ **Status: under active development, pre-alpha.** Nothing here is ready for production yet.
> The [releases](https://github.com/hopper-panel/hopper/releases) say what each version changed.

## Installation

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
sudo bash install/install.sh
```

Debian 12+, Ubuntu 22.04+, Rocky or Alma 9+. The script asks four questions — domain, nginx or
apache, certificate, administrator account — then installs everything else and declares the local
node. See the [installation documentation](./docs/installation.md).

## Why Hopper?

The existing panels force an unpleasant trade-off:

- **Pterodactyl** is excellent but fragmented — PHP/Laravel for the panel, Go for the daemon, three
  repositories, a long manual installation and a pile of system dependencies.
- **PufferPanel** is simple to install but runs servers as bare processes: no real isolation, no
  reliable resource limits, no serious backups.

Hopper aims for the middle:

- **One language.** TypeScript from the daemon to the front end. One `git clone`, one `pnpm install`.
- **An installer that does the work.** It asks for nginx or apache and your domain, then lays down
  the vhost, the certificate, the systemd services and the database.
- **Real isolation.** One Docker container per server, CPU/RAM/disk limits enforced by the kernel,
  capabilities dropped, never `--privileged`.

## Features

|                          |                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 🖥️ **Live console**      | WebSocket straight to the daemon, history, command input                                                                          |
| 📊 **Resources**         | CPU, RAM, disk and network in real time                                                                                           |
| 📦 **One-click install** | Minecraft (Paper, Purpur, Vanilla, Fabric, NeoForge), the Velocity and BungeeCord proxies, Factorio, Source servers, Discord bots |
| 🥚 **Egg import**        | Reuse the hundreds of existing Pterodactyl eggs, ports and config files included                                                  |
| ✏️ **Template editor**   | Write your own, in groups, from the administration                                                                                |
| 📁 **File manager**      | In-browser editing of any text file, upload, archives — behind a strict path jail                                                 |
| 🔌 **Built-in SFTP**     | Sign in with your panel credentials, permissions honoured                                                                         |
| 💾 **Backups**           | Compressed archives on the node, one-click restore                                                                                |
| ⏰ **Scheduler**         | Daily restart, nightly backup, scheduled commands                                                                                 |
| 👥 **Subusers**          | Share a server with your staff, permission by permission                                                                          |
| 🔔 **Notifications**     | Discord or a signed webhook: server down, backup finished                                                                         |
| 🔑 **API keys**          | Drive your servers from a script, with scopes                                                                                     |
| 🌍 **Five languages**    | English, French, Spanish, German, Russian                                                                                         |
| 🖧 **Multi-machine**      | One panel, as many nodes as you need                                                                                              |

## Architecture

```
 Browser
   │  HTTPS (REST)                    ┌──────────────────────────────┐
   ├─────────────────────────────────▶│  PANEL (NestJS + React)      │
   │                                  │  :8080  PostgreSQL + Redis   │
   │  WSS console/stats               └──────────────┬───────────────┘
   │  (short JWT signed by the panel)                │ REST (node token)
   │                                                 ▼
   └────────────────────────────────▶┌──────────────────────────────┐
                                     │  HOPPERD (Node/TS)  :8443    │
                                     │  SFTP :2022                  │
                                     │  dockerode ──▶ containers    │
                                     └──────────────────────────────┘
                                            /var/lib/hopper/volumes/<uuid>
```

Two processes, two clear roles:

- **The panel** holds the database, the authentication and the web interface.
- **The daemon (`hopperd`)** runs on each host machine, drives Docker and serves the files. It has
  no access to the database: it receives a server configuration as JSON and calls the panel back on
  `/api/remote/*`.

The console **does not travel through the panel**: the browser opens a WebSocket straight to the
daemon with a short-lived JWT signed by the panel. The panel never becomes a bottleneck, even with
fifty consoles open.

## Repository layout

```
hopper/
├── apps/
│   ├── panel/            # NestJS API + React front (apps/panel/web)
│   └── daemon/           # hopperd — the Docker agent on each machine
├── packages/
│   ├── shared/           # Zod panel↔daemon contract, permissions
│   ├── templates/        # server templates + Pterodactyl egg import/export
│   └── config/           # shared ESLint / TypeScript
├── docker/               # dev compose (PostgreSQL, Redis)
├── install/              # install.sh, uninstall.sh, systemd units, nginx & apache vhosts
└── docs/                 # installation, updating, CLI, templates, security
```

## Development

Requirements: **Node 22+**, **pnpm 10+**, **Docker**.

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
pnpm install

# Postgres + Redis locally
pnpm dev:services

cp apps/panel/.env.example apps/panel/.env
# Replace APP_SECRET with a random value: openssl rand -base64 48

pnpm --filter @hopper/panel db:migrate
pnpm --filter @hopper/panel db:seed   # prints the generated admin password

pnpm dev
```

| Service          | Address                 |
| ---------------- | ----------------------- |
| Interface (Vite) | <http://localhost:5173> |
| Panel API        | <http://localhost:8080> |
| Daemon           | <http://localhost:8443> |

The interface calls the API on a relative path: Vite forwards `/api` to the panel, which avoids any
client-side CORS configuration in development.

The administration command line is available as `pnpm --filter @hopper/panel cli <command>` in
development, and `hopper <command>` on an installed machine — see [docs/cli.md](./docs/cli.md).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the commit conventions, the tests and the review
process.

## Security

Hopper runs arbitrary code and handles user filesystems. Please **do not open a public issue** for a
vulnerability — see [SECURITY.md](./SECURITY.md).

## Licence

[GNU AGPL v3](./LICENSE) — you may use, modify and host Hopper freely, but if you offer a modified
version as a service, you have to publish its source code.
