# Application API

For hosting providers using Hopper as their customers' panel, and driving it from their own
software — a billing system, an internal back office, a status page.

It is a separate API from the one described in [API and notifications](./api.md), and the separation
is the point. That one is reached with a **personal** key: it borrows its owner's access, opens
exactly the servers that person opens, and stops working the day they are demoted, suspended or
deleted. Right for a key someone pastes into a script. Wrong for the credential that delivers a
paid-for server, which must not depend on an administrator still working there.

## The credential

An **application key** belongs to nobody. Create one from the command line:

```bash
hopper application-key:create --name Paymenter --scopes write
```

The token is printed once, alone on the last line — so `| tail -1` is a reasonable thing to write in
an installation script. It is stored hashed; losing it means creating another.

```
hpa_A1b2C3d4E5f6G7h8.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Two scopes:

| Scope   | What it allows                                       |
| ------- | ---------------------------------------------------- |
| `read`  | `GET` — describing plans, servers, capacity          |
| `write` | Everything that acts — provisioning, suspending, ... |

A provider running both a billing system and a public status page is expected to hold **two keys**,
so the one in the page that anybody can load cannot delete a customer's server.

Restrict a key to the addresses it will actually come from. A billing server has a fixed address far
more often than a person does, which makes this cheap here and useless there:

```bash
hopper application-key:create --name WHMCS --scopes write --allowed-ips 203.0.113.7
```

Also `hopper application-key:list` and `hopper application-key:revoke --uuid <uuid>`, and the same
three actions under `/api/admin/application-keys` for an administrator driving them from a script.

A key is **revoked, never deleted**: it stays nameable in the audit trail of the two hundred servers
it provisioned.

## What a key opens, and what it does not

An application key opens `/api/application/*` **and nothing else**. Not the administration, not a
file, not a console. It is the credential most likely to leak — it lives in a configuration file on a
billing server — so its blast radius is bounded by the surface it reaches rather than by the hope
that nobody misuses it. Presented anywhere else, it is refused and told so:

```json
{
  "message": "An application key only opens /api/application. Use a personal API key for the rest."
}
```

The exclusion runs both ways: `/api/application/*` refuses a browser session and refuses a personal
key, administrator's included. That refusal exists to stop an integration being half-built on a
session that expires or on a key that dies with its owner's account, and discovering the difference
on the day it stops provisioning.

Notably, an application key **cannot create another application key**: that route is under
`/api/admin`. One leaked credential must not become a permanent foothold.

## Checking the wiring

```bash
curl -H "Authorization: Bearer hpa_…" https://panel.example.com/api/application/instance
```

```json
{
  "panel": { "version": "0.18.0", "api": 1 },
  "key": { "uuid": "3f1c…", "name": "Paymenter", "scopes": ["read", "write"] }
}
```

Three answers that are otherwise each a support ticket: the key reaches the right panel, it is
allowed to do what you thought, and this panel understands the contract your integration was written
against. Reachable with a `read` key — checking a credential should not need the credential that
changes things.

`panel.api` is the version of **this contract**, moved by hand, and not the panel's version, which
moves on every release including the ones that change nothing here. Pin against `api`. A new route
or a new optional field does not move it; a removed field, a renamed one or a changed meaning does.

## Plans — what you sell

A **plan** is an offer: a name, a template, a set of limits, and the machines it may be placed on.
It exists because of who calls this API. Without it, a billing system has to know the panel's
internals to sell anything — which template uuid, how many bytes of memory, which node has a free
port — and every one of those then lives in a second product's configuration, drifting from this
one. A plan moves that knowledge into the panel, where the person who decides what is sold can
change it, and leaves the billing system a name to quote.

Plans are **written from the administration** (`/api/admin/plans`, or the Plans screen) and **read
here**. A billing system that could create offers would put the catalogue back in two places at
once.

```bash
curl -H "Authorization: Bearer hpa_…" https://panel.example.com/api/application/plans
```

```json
[
  {
    "uuid": "9c2e…",
    "slug": "minecraft-4gb",
    "name": "Minecraft 4 GB",
    "description": "Paper, 4 GB of memory, 20 GB of disk",
    "template": { "uuid": "3f1c…", "name": "Paper" },
    "dockerImage": "",
    "limits": {
      "memoryBytes": 4294967296,
      "diskBytes": 21474836480,
      "swapBytes": 0,
      "cpuPercent": 0,
      "ioWeight": 500,
      "pidsLimit": 512,
      "oomKillDisabled": false,
      "backupLimit": 3,
      "allocationLimit": 0,
      "databaseLimit": 0
    },
    "nodes": [],
    "active": true
  }
]
```

Only **active** plans are listed: a retired offer still exists, and the customers on it still run,
but a system asking "what can I sell" should not be handed something the operator withdrew.

`slug` is the reference — it is what a human types into a product's configuration and reads back in
a support ticket. Renaming a plan is therefore a breaking change for whatever sells it.

`nodes` empty means **anywhere**, not nowhere. An operator with one machine never has to name it.

A plan is a template for creating a server, not a live dependency: the limits are **copied onto the
server** at creation, the way a startup command is copied from its template. Editing an offer
changes what the _next_ purchase gets and touches nothing already running.

### Is it still sellable?

```bash
curl -H "Authorization: Bearer hpa_…"      https://panel.example.com/api/application/plans/minecraft-4gb/availability
```

```json
{
  "plan": { "slug": "minecraft-4gb", "name": "Minecraft 4 GB", "active": true },
  "available": true,
  "blockedBy": []
}
```

Ask before taking the money. "Sold out" on a purchase page costs a sentence; a refund costs a
support ticket, a payment reversal and the customer's afternoon.

When nothing fits, `blockedBy` names every machine that was passed over and why:

```json
{
  "available": false,
  "blockedBy": [
    { "node": "paris-1", "reason": "maintenance" },
    { "node": "paris-2", "reason": "no-free-port" },
    { "node": "lille-1", "reason": "not-enough-memory" }
  ]
}
```

Those are four different afternoons for whoever has to fix it — lifting a flag, adding ports, or
buying a machine — which is why they are not collapsed into "unavailable".

The answer deliberately does **not** name the machine that would have been chosen. Which node a
server lands on is the panel's business, and an integration that started routing on it would break
the day the operator adds one.

### How a node is chosen

Among the machines a plan allows: not in maintenance, with a free port, and with room for the
plan's memory and disk once that node's own overallocation is taken into account. Of those, the one
with the **most free memory** wins.

Spread, not pack. Filling one machine before touching the next costs less hardware and buys the
worst failure this software has: when every server on a full node really claims its quota, the
kernel's OOM killer picks victims at random, across customers who have nothing to do with each
other. Overallocation is already the lever for density, it is set per node, and an operator who
wants tighter packing has it.

A node that declares no capacity is used **last** — declaring nothing means "I manage this machine
by hand", which is the wrong default place for a server sold automatically, and still better than
refusing a sale.

Ties break deterministically. The same request answered twice puts two servers in the same place,
rather than scattering one customer's servers for a reason nobody could reconstruct later.

## Selling a server

```bash
curl -X POST https://panel.example.com/api/application/servers      -H "Authorization: Bearer hpa_…"      -H "Idempotency-Key: order-1041"      -H "Content-Type: application/json"      -d '{
           "plan": "minecraft-4gb",
           "name": "Survival",
           "owner": { "email": "customer@example.com" }
         }'
```

That is the whole call. Everything absent from it — the node, the port, the template, twelve
resource limits — is a decision the panel is better placed to make, and one that would otherwise
have to be configured a second time in your billing system and kept in step by hand.

It finds or creates the customer's account, picks a machine, takes a port, applies the plan's
limits, and asks the daemon to install:

```json
{
  "uuid": "1b32d12d-…",
  "name": "Survival",
  "status": "INSTALLING",
  "plan": { "slug": "minecraft-4gb", "name": "Minecraft 4 GB" },
  "owner": { "uuid": "7c4a…", "email": "customer@example.com", "username": "customer" },
  "address": { "host": "mc.example.com", "port": 25565 },
  "node": { "name": "paris-1" },
  "limits": { "memoryBytes": 4294967296, "diskBytes": 21474836480, "cpuPercent": 0 },
  "ownerCreated": true
}
```

`ownerCreated` tells a first purchase from a returning customer without a second question — and
tells you an invitation email is on its way, so your own welcome message does not duplicate it. An
account created this way has **no password**: the customer receives a link and chooses one. A
password set here would travel through a channel neither of us controls, and usually stay unchanged.

`status` is `INSTALLING`: the container is being built. Nothing else is needed from you — but see
the note on knowing when it finishes, below.

### `Idempotency-Key` is required

Unusually, and deliberately. This is the only route here that is not naturally repeatable —
suspending twice is a no-op, deleting twice is a `404`, creating twice is **two servers and two
invoices** — and the call most likely to be repeated is the one that timed out, where you cannot
tell "it never arrived" from "it worked and the answer was lost". Making the header optional would
make the safe default the unsafe one, and the integrations that skip it are exactly the ones that
will retry.

Use the identifier of the thing that caused the purchase: an order number, a subscription id. Not a
random value generated per attempt — that defeats the point.

A repeat of a settled call replays the original answer, with `Idempotency-Replayed: true` so you can
tell them apart in a log:

| Situation                                | Answer                                     |
| ---------------------------------------- | ------------------------------------------ |
| First call                               | `201` with the server                      |
| Same key, same body, first call finished | `201` with the **same** server, replayed   |
| Same key, first call still running       | `409` — retry in a moment                  |
| Same key, **different** body             | `422` — the key is being reused by mistake |
| First call failed                        | The key is released; retrying is allowed   |

That last row matters: a failed provisioning call is the one you most need to make again — a node in
maintenance, a daemon restarting. A key that answered `500` for a day would turn a transient failure
into an unsellable order.

Keys are scoped to the key that made the call, and expire after 24 hours.

### When there is no room

```json
{
  "statusCode": 409,
  "message": "No node can take a server on \"minecraft-4gb\" right now: paris-1 (maintenance), paris-2 (no-free-port), lille-1 (not-enough-memory)."
}
```

Every machine that was passed over, with what stopped it. Ask
`/api/application/plans/:slug/availability` **before** taking the money and this arrives on a
purchase page instead of in a refund.

## The rest of the lifecycle

```
GET    /api/application/servers?owner=customer@example.com   what this customer has
GET    /api/application/servers?plan=minecraft-4gb           who is on an offer
GET    /api/application/servers/:uuid                        one server
POST   /api/application/servers/:uuid/suspend                invoice unpaid
POST   /api/application/servers/:uuid/unsuspend              invoice settled
PATCH  /api/application/servers/:uuid/plan                   upgrade or downgrade
DELETE /api/application/servers/:uuid                        cancellation
```

**Suspending is repeatable.** Sending it twice is not an error; the answer carries `changed`, saying
whether anything moved. A billing system reacting to an unpaid invoice sends it on a schedule, and a
`409` on the second one would have every integrator write the same "is it already suspended" check
— a check that races with the panel's own screen.

A suspended server stops and its owner can no longer reach it. Their **account** is untouched: a
customer with three servers and one unpaid invoice keeps the other two.

**Changing plan** applies the new offer's limits and records what the server is now sold under:

```bash
curl -X PATCH https://panel.example.com/api/application/servers/1b32d12d-…/plan      -H "Authorization: Bearer hpa_…"      -H "Content-Type: application/json"      -d '{"plan": "minecraft-8gb"}'
```

Only the plan — sending arbitrary limits alongside it would make "what is this customer paying for"
unanswerable from the panel. The server **stays on its machine**: moving it between nodes is a
transfer, which copies a world across a network, takes minutes and can fail halfway. Doing that
silently because somebody bought more memory would be the worst possible moment to find out. If the
new plan is not offered on the node the server runs on, the call is refused and says so.

The new limits take effect when the container is next rebuilt — the panel marks it, the daemon
applies it on the next start.

**Deleting** destroys the server, its volume and its backups. It is irreversible and reachable by a
machine, which is why it needs a `write` key and why the audit entry names the integration that
asked.

## What the audit trail shows

Every action taken through this API is recorded with **no actor** — the column already means "issued
by the system" — and the integration's name in the metadata. Inventing a user to put there would
have the trail name somebody who was asleep.

`server.provisioned` is recorded alongside the ordinary `server.created`, deliberately: an operator
asking "which of these came from the billing system" needs the two to be tellable apart.

## Being told, instead of asking

Provisioning answers in a second with `INSTALLING`. Whether the container actually came up is
decided **minutes later**, long after that call returned — which is the one thing an integration
cannot observe for itself, and the reason instance-wide notifications exist.

Add one in the administration (`/api/admin/instance-webhooks`), give it an address and the events
you want:

| Event                   | Sent when                                                     |
| ----------------------- | ------------------------------------------------------------- |
| `server.provisioned`    | a server was sold through this API                            |
| `server.installed`      | its installation finished — it is usable                      |
| `server.install-failed` | its installation failed; the server exists and will not start |
| `server.suspended`      | it was suspended, from here **or from the panel**             |
| `server.unsuspended`    | it was reinstated                                             |
| `server.plan-changed`   | it moved onto another offer                                   |
| `server.deleted`        | it was deleted                                                |

The lifecycle events are not redundant with your own records. An operator's estate changes from two
directions, and a server suspended by an administrator clicking a button in the panel is the same
event to anything keeping a mirror — it is just the one your billing system does not already know
about.

Every request carries `X-Hopper-Event` and `X-Hopper-Signature`, an HMAC-SHA256 of the body, using a
secret you can read once from the administration. **Verify it**: a webhook URL always ends up
circulating, and without a signature anybody who learns it can tell you a customer cancelled.

The body is the same shape for every event, so one handler routes on `event`:

```json
{
  "event": "server.installed",
  "occurredAt": "2026-08-22T14:03:11.000Z",
  "server": {
    "uuid": "1b32d12d-…",
    "name": "Survival",
    "planSlug": "minecraft-4gb",
    "ownerEmail": "customer@example.com",
    "address": "mc.example.com:25565",
    "node": "paris-1"
  },
  "details": { "reinstall": false }
}
```

No Discord formatting here, unlike the per-server notifications: the reader is a program keeping a
mirror of an estate, not a person watching a channel.

Sends are not retried, and a recipient that fails **twenty times in a row disables itself** — a dead
address otherwise costs five seconds of timeout on every sale. Treat these as a fast path, not as a
ledger: `GET /api/application/servers/:uuid` is always the truth, and an integration that has been
offline should reconcile against it rather than assume it missed nothing.

## What is not here yet

- **No single sign-on.** A customer clicking "manage my server" in your portal lands on the panel's
  own sign-in page.
- **No transfers.** Changing plan keeps a server on its machine; moving it between nodes is done
  from the administration.

## Errors

Ordinary HTTP, with a message meant to be read by whoever integrates rather than by an end customer:

| Code  | Means                                                                  |
| ----- | ---------------------------------------------------------------------- |
| `401` | No credential, or one that is invalid, expired or revoked              |
| `403` | A credential that is valid but not allowed here — wrong kind, or scope |
| `404` | The object does not exist                                              |
| `409` | The request conflicts with the current state                           |
| `422` | The body did not validate; the answer says which field                 |

`401` never distinguishes "unknown key" from "wrong secret" from "revoked": telling them apart would
tell a caller which identifiers exist.
