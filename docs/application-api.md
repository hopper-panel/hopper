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
  "panel": { "version": "0.17.1", "api": 1 },
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
