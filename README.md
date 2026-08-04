<div align="center">

# 🪣 Hopper Panel

**Un panel open-source pour héberger vos serveurs Minecraft, chez vous.**

Console live, gestionnaire de fichiers, SFTP, backups, tâches planifiées — chaque serveur isolé
dans son propre conteneur Docker.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

</div>

---

> ⚠️ **Statut : en développement actif, pré-alpha.** Rien n'est encore utilisable en production.
> Suivez la [feuille de route](#feuille-de-route) pour savoir où en est le projet.

## Installation

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
sudo bash install/install.sh
```

Debian 12+, Ubuntu 22.04+, Rocky ou Alma 9+. Le script pose quatre questions — domaine, nginx ou
apache, certificat, compte administrateur — puis installe tout le reste et déclare le node local.
Voir la [documentation d'installation](./docs/installation.md).

## Pourquoi Hopper ?

Les panels existants forcent un compromis désagréable :

- **Pterodactyl** est excellent mais fragmenté — PHP/Laravel côté panel, Go côté daemon, trois dépôts,
  une installation manuelle longue et une pile de dépendances système.
- **PufferPanel** est simple à installer mais lance les serveurs en processus nus : pas de vraie
  isolation, pas de limites de ressources fiables, pas de backups sérieux.

Hopper vise le milieu :

- **Un seul langage.** TypeScript du daemon jusqu'au front. Un `git clone`, un `pnpm install`.
- **Un installeur qui fait le travail.** Il vous demande nginx ou apache, votre domaine, et il pose
  le vhost, le certificat, les services systemd et la base de données.
- **Une isolation réelle.** Un conteneur Docker par serveur, limites CPU/RAM/disque appliquées par le
  noyau, capabilities droppées, jamais de `--privileged`.

## Fonctionnalités

|                                 |                                                                     |
| ------------------------------- | ------------------------------------------------------------------- |
| 🖥️ **Console live**             | WebSocket direct vers le daemon, historique, envoi de commandes     |
| 📊 **Ressources**               | CPU, RAM, disque et réseau en temps réel                            |
| 📦 **Installation en un clic**  | Paper, Purpur, Vanilla, Fabric, NeoForge, Velocity, BungeeCord      |
| 🥚 **Import d'eggs**            | Réutilisez les centaines d'eggs Pterodactyl existants               |
| 📁 **Gestionnaire de fichiers** | Édition en ligne, upload, archives — avec un jail de chemins strict |
| 🔌 **SFTP intégré**             | Connexion avec vos identifiants du panel, permissions respectées    |
| 💾 **Backups**                  | Locaux ou S3 (MinIO, Backblaze, Wasabi), restauration en un clic    |
| ⏰ **Planificateur**            | Restart quotidien, backup nocturne, commandes programmées           |
| 👥 **Sous-utilisateurs**        | Partagez un serveur avec votre staff, permission par permission     |
| 🔔 **Notifications**            | Discord ou webhook signé : serveur tombé, sauvegarde terminée       |
| 🔑 **Clés d'API**               | Pilotez vos serveurs depuis un script, avec des portées             |
| 🖧 **Multi-machines**            | Un panel, autant de nodes que nécessaire                            |

## Architecture

```
 Navigateur
   │  HTTPS (REST)                    ┌──────────────────────────────┐
   ├─────────────────────────────────▶│  PANEL (NestJS + React)      │
   │                                  │  :8080  PostgreSQL + Redis   │
   │  WSS console/stats               └──────────────┬───────────────┘
   │  (JWT court signé par le panel)                 │ REST (token de node)
   │                                                 ▼
   └────────────────────────────────▶┌──────────────────────────────┐
                                     │  HOPPERD (Node/TS)  :8443    │
                                     │  SFTP :2022                  │
                                     │  dockerode ──▶ conteneurs    │
                                     └──────────────────────────────┘
                                            /var/lib/hopper/volumes/<uuid>
```

Deux processus, deux rôles nets :

- **Le panel** détient la base de données, l'authentification et l'interface web.
- **Le daemon (`hopperd`)** tourne sur chaque machine hôte, pilote Docker et sert les fichiers.
  Il n'a aucun accès à la base : il reçoit une configuration de serveur en JSON et rappelle le panel
  sur `/api/remote/*`.

La console **ne transite pas par le panel** : le navigateur ouvre un WebSocket directement vers le
daemon avec un JWT de courte durée signé par le panel. Le panel ne devient jamais un goulot
d'étranglement, même avec cinquante consoles ouvertes.

## Structure du dépôt

```
hopper/
├── apps/
│   ├── panel/            # API NestJS + front React (apps/panel/web)
│   └── daemon/           # hopperd — agent Docker sur chaque machine
├── packages/
│   ├── shared/           # contrat Zod panel↔daemon, permissions
│   ├── templates/        # templates de serveurs + import d'eggs Pterodactyl
│   └── config/           # ESLint / TypeScript partagés
├── docker/               # images Java, compose de dev
├── install/              # install.sh, units systemd, vhosts nginx & apache
└── docs/                 # installation, mise à jour, CLI, templates, sécurité
```

## Développement

Prérequis : **Node 22+**, **pnpm 10+**, **Docker**.

```bash
git clone https://github.com/hopper-panel/hopper.git
cd hopper
pnpm install

# Postgres + Redis en local
pnpm dev:services

cp apps/panel/.env.example apps/panel/.env
# Remplacez APP_SECRET par une valeur aléatoire : openssl rand -base64 48

pnpm --filter @hopper/panel db:migrate
pnpm --filter @hopper/panel db:seed   # affiche le mot de passe admin généré

pnpm dev
```

| Service          | Adresse                                           |
| ---------------- | ------------------------------------------------- |
| Interface (Vite) | <http://localhost:5173>                           |
| API du panel     | <http://localhost:8080>                           |
| Daemon           | <http://localhost:8443>                           |
| Console MinIO    | <http://localhost:9001> (hopperadmin/hopperadmin) |

L'interface appelle l'API en chemin relatif : Vite fait suivre `/api` vers le panel, ce qui évite
toute configuration CORS côté client en développement.

La ligne de commande d'administration s'obtient avec `pnpm --filter @hopper/panel cli <commande>`
en développement, et `hopper <commande>` sur une machine installée — voir [docs/cli.md](./docs/cli.md).

Voir [CONTRIBUTING.md](./CONTRIBUTING.md) pour les conventions de commit, les tests et le processus
de revue.

## Feuille de route

- [x] **Phase 0** — Fondations du monorepo, contrat partagé, squelettes panel & daemon
- [x] **Phase 1** — Schéma de données, authentification, 2FA, RBAC, shell de l'interface
- [x] **Phase 2** — Runtime Docker, console live, statistiques _(le jalon qui valide tout)_
- [x] **Phase 3** — Templates de serveurs et installation automatique
- [x] **Phase 4** — Gestionnaire de fichiers et SFTP
- [x] **Phase 5** — Backups, planificateur, sous-utilisateurs
- [x] **Phase 6** — Installeur système (nginx/apache), CLI `hopper`, documentation
- [ ] **Phase 7** — Bases MySQL par serveur _(faites)_, transfert entre nodes, passkeys, i18n

## Sécurité

Hopper exécute du code arbitraire et manipule des systèmes de fichiers utilisateur. Merci de **ne pas
ouvrir d'issue publique** pour une vulnérabilité — voir [SECURITY.md](./SECURITY.md).

## Licence

[GNU AGPL v3](./LICENSE) — vous pouvez utiliser, modifier et héberger Hopper librement, mais si vous
proposez une version modifiée comme service, vous devez en publier le code source.
