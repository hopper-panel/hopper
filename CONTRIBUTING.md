# Contributing to Hopper

Thanks for wanting to help. This document explains how to set the environment up, what is expected
of a contribution, and the handful of non-negotiable rules.

## Development environment

Requirements: **Node 22+**, **pnpm 10+**, **Docker** (with the daemon reachable by the current
user), and **git**.

```bash
pnpm install
pnpm dev:services                       # Postgres + Redis
cp apps/panel/.env.example apps/panel/.env
pnpm --filter @hopper/panel prisma migrate dev
pnpm dev                                # panel :8080, daemon :8443
```

Useful commands:

| Command          | Effect                               |
| ---------------- | ------------------------------------ |
| `pnpm build`     | Build every package                  |
| `pnpm typecheck` | TypeScript checking without emitting |
| `pnpm lint`      | ESLint across the monorepo           |
| `pnpm test`      | Unit tests (Vitest)                  |
| `pnpm format`    | Prettier formatting                  |

## Layout

Before adding code, check that it goes in the right place:

- `packages/shared` — **every** shape of data that travels between the panel and the daemon. It is
  the source of truth: a Zod schema is defined there once and imported on both sides. If you are
  about to duplicate an interface, stop and put it here.
- `apps/panel` — API and interface. Holds the database. Never talks to Docker.
- `apps/daemon` — drives Docker and the filesystem. Never touches the database.
- `packages/templates` — server definitions (the counterpart of Pterodactyl's "eggs").

## Non-negotiable rules

These concern the security of the host and block a PR without discussion:

1. **No access to a server's filesystem outside `JailedFilesystem`.** No direct `fs.readFile` on a
   path that came from a request, not even "just for a test".
2. **No string concatenation handed to a shell.** Startup commands are templates with validated
   variables.
3. **No privileged containers**, and never mount the Docker socket into a server container.
4. **No secrets in the logs.** Tokens, passwords and keys are redacted by the logger.
5. **A security fix ships with a regression test** that fails without the fix.

## Code style

Formatting is automatic (Prettier): do not argue about braces, run `pnpm format`.

What matters more:

- **Write everything in English** — names, comments, log lines, error messages, test titles. The
  interface is translated through the message catalogues in
  `apps/panel/web/src/i18n/messages/`; nothing else is.
- **Comment the "why", not the "what".** `// increment i` adds nothing;
  `// Paper writes this file after the first start, hence the retry` adds a great deal.
- **Keep only the comments that earn their place.** A comment restating the line below it is worse
  than no comment: it goes stale and misleads.
- **No `any`.** If the typing resists, use `unknown` and narrow with a Zod schema.
- **Errors surface typed.** No silent `catch {}` on a critical path.

### Strings a machine reads

Some strings are read by another program rather than by a person — `HOPPER_SEED_ADMIN_CREATED=1`,
which `install.sh` greps for, is the example. They are marked as such in a comment. **Do not
translate or reword them.** Rewording one silently broke the installer once: it stopped showing the
generated administrator password, leaving an installation nobody could sign in to.

## Tests

- **Unit (Vitest)** for pure logic: permissions, template parsing, `JailedFilesystem`.
- **Integration (Testcontainers)** for anything touching Docker: the daemon has to be tested against
  a real daemon, not against a `dockerode` mock.
- **E2E (Playwright)** for the critical user journeys: sign-in, server creation, console.

Code touching file paths, permissions or tokens **must** be covered, including by explicit attack
cases (`../../etc/passwd`, a symlink to `/`, an archive containing `../`).

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(daemon): stream container stats over the WebSocket
fix(panel): refuse an allocation port already taken on the same node
docs(install): spell out the apache modules the WebSocket needs
```

Usual scopes: `panel`, `daemon`, `web`, `shared`, `templates`, `cli`, `install`, `docker`, `ci`.

For a pull request:

- one PR, one subject; if you fix a bug _and_ refactor, open two PRs;
- describe **why** the change is needed, not only what it does;
- `pnpm lint && pnpm typecheck && pnpm test` have to pass;
- if the change is visible in the interface, attach a screenshot;
- if the change touches security, say so explicitly in the description.

## Adding a server template

Templates live in `packages/templates/src/catalog/`, one file per family. A template describes the
Docker image, the startup command, the install script, the variables exposed to the user and how the
daemon decides the server is ready — `readiness`, which is one of four strategies and no longer a
regex over the console alone: a Source server never prints `Done (12.4s)!`, and a game that says
nothing at all on stdout cannot be waited for that way.

A template imported from a Pterodactyl egg goes through
`packages/templates/src/pterodactyl-importer.ts` — do not write the conversion by hand.

## Adding a language

The interface ships in English, French, Spanish, German and Russian. English is the source: every
key exists in `apps/panel/web/src/i18n/messages/en.ts`, and the other catalogues are typed as
`Partial<Messages>`, so a missing key falls back to English rather than showing a blank.

To add a language, copy `en.ts`, translate the values, and register the locale in
`apps/panel/web/src/i18n/locales.ts`. Keep the language's own name in the picker — `Français`, not
`French`.

## Discussions

An idea for a feature, a doubt about an approach: open a **Discussion** before writing code. It is
quicker for everyone than a 2000-line PR heading in the wrong direction.
