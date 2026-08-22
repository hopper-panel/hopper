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
