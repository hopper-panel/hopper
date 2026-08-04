# Contribuer à Hopper

Merci de vouloir aider. Ce document explique comment monter l'environnement, ce qu'on attend d'une
contribution, et les quelques règles non négociables.

## Environnement de développement

Prérequis : **Node 22+**, **pnpm 10+**, **Docker** (avec le démon accessible par l'utilisateur
courant), et **git**.

```bash
pnpm install
pnpm dev:services                       # Postgres + Redis
cp apps/panel/.env.example apps/panel/.env
pnpm --filter @hopper/panel prisma migrate dev
pnpm dev                                # panel :8080, daemon :8443
```

Commandes utiles :

| Commande         | Effet                                 |
| ---------------- | ------------------------------------- |
| `pnpm build`     | Build de tous les paquets             |
| `pnpm typecheck` | Vérification TypeScript sans émission |
| `pnpm lint`      | ESLint sur l'ensemble du monorepo     |
| `pnpm test`      | Tests unitaires (Vitest)              |
| `pnpm format`    | Formatage Prettier                    |

## Structure

Avant d'ajouter du code, vérifiez qu'il va au bon endroit :

- `packages/shared` — **toute** forme de donnée qui circule entre le panel et le daemon. C'est la
  source de vérité : un schéma Zod y est défini une fois et importé des deux côtés. Si vous vous
  apprêtez à dupliquer une interface, arrêtez-vous et mettez-la ici.
- `apps/panel` — API et interface. Contient la base de données. Ne parle jamais à Docker.
- `apps/daemon` — pilote Docker et le système de fichiers. N'accède jamais à la base de données.
- `packages/templates` — définitions de serveurs (le pendant des « eggs »).

## Règles non négociables

Ces points concernent la sécurité de l'hôte et bloquent une PR sans discussion :

1. **Aucun accès au système de fichiers d'un serveur en dehors de `JailedFilesystem`.** Pas de
   `fs.readFile` direct sur un chemin venu d'une requête, même « juste pour un test ».
2. **Aucune concaténation de chaîne passée à un shell.** Les commandes de démarrage sont des gabarits
   à variables validées.
3. **Aucun conteneur privilégié**, aucun montage du socket Docker dans un conteneur de serveur.
4. **Aucun secret dans les logs.** Jetons, mots de passe et clés sont masqués par le logger.
5. **Un correctif de sécurité vient avec un test de régression** qui échoue sans le correctif.

## Style de code

Le formatage est automatique (Prettier) : ne discutez pas des accolades, lancez `pnpm format`.

Ce qui compte davantage :

- **Nommez les choses en anglais dans le code**, commentez en français ou en anglais mais restez
  cohérent dans un même fichier.
- **Commentez le « pourquoi », pas le « quoi ».** `// incrémente i` n'apporte rien ;
  `// Paper écrit ce fichier après le premier démarrage, d'où le retry` en apporte beaucoup.
- **Pas de `any`.** Si le typage résiste, utilisez `unknown` et affinez avec un schéma Zod.
- **Les erreurs remontent typées.** Pas de `catch {}` silencieux dans un chemin critique.

## Tests

- **Unitaires (Vitest)** pour la logique pure : permissions, parsing de templates, `JailedFilesystem`.
- **Intégration (Testcontainers)** pour tout ce qui touche Docker : le daemon doit être testé contre
  un vrai démon, pas contre un mock de `dockerode`.
- **E2E (Playwright)** pour les parcours utilisateur critiques : connexion, création de serveur,
  console.

Le code touchant aux chemins de fichiers, aux permissions ou aux jetons **doit** être couvert, y
compris par des cas d'attaque explicites (`../../etc/passwd`, symlink vers `/`, archive contenant
`../`).

## Commits et pull requests

Les commits suivent [Conventional Commits](https://www.conventionalcommits.org/) :

```
feat(daemon): stream des stats de conteneur par WebSocket
fix(panel): refuse un port d'allocation déjà pris sur le même node
docs(install): précise les modules apache requis pour le WebSocket
```

Portées usuelles : `panel`, `daemon`, `web`, `shared`, `templates`, `cli`, `install`, `docker`, `ci`.

Pour une pull request :

- une PR = un sujet ; si vous corrigez un bug _et_ refactorez, faites deux PR ;
- décrivez **pourquoi** le changement est nécessaire, pas seulement ce qu'il fait ;
- `pnpm lint && pnpm typecheck && pnpm test` doivent passer ;
- si le changement est visible dans l'interface, joignez une capture ;
- si le changement touche la sécurité, dites-le explicitement dans la description.

## Ajouter un template de serveur

Les templates vivent dans `packages/templates/src/`. Un template décrit l'image Docker, la commande
de démarrage, le script d'installation, les variables exposées à l'utilisateur et la regex qui
signale que le serveur est prêt.

Un template importé depuis un « egg » Pterodactyl passe par
`packages/templates/src/pterodactyl-importer.ts` — n'écrivez pas la conversion à la main.

## Discussions

Une idée de fonctionnalité, un doute sur une approche : ouvrez une **Discussion** avant d'écrire du
code. C'est plus rapide pour tout le monde qu'une PR de 2000 lignes qui part dans la mauvaise
direction.
