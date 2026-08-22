# API and notifications

For personal keys and outgoing webhooks. If you are a **hosting provider** wiring a billing system to
Hopper, the credential and the routes you want are in [Application API](./application-api.md): a key
here borrows its owner's access and stops working when that account does, which is the wrong shape
for provisioning.

## API keys

**My account → API keys**. A key borrows its owner's access: it never opens a server they could not
open themselves. The token is shown **once only**, at creation.

```bash
curl -H "Authorization: Bearer hpk_xxxxxxxxxxxxxxxx.yyyy…" \
     https://panel.example.com/api/servers
```

Three scopes, which can be combined:

| Scope   | What it allows                                                   |
| ------- | ---------------------------------------------------------------- |
| `read`  | `GET` requests — viewing servers, files, backups                 |
| `write` | Requests that act — starting, writing a file, taking a backup    |
| `admin` | The `/api/admin/*` routes, and only for an administrator account |

A read key cannot stop a server: that is the point of these scopes. The account's role is rechecked
on every request, so a demotion takes effect without having to revoke keys one by one.

A key can be restricted to source IP addresses and given an expiry date. An empty address list
imposes no restriction.

A few useful routes:

```
GET    /api/servers                       the servers you can reach
GET    /api/servers/:uuid                 one server in detail
POST   /api/servers/:uuid/power           {"action":"start|stop|restart|kill"}
GET    /api/servers/:uuid/files/list?path=/
POST   /api/servers/:uuid/backups         triggers a backup
GET    /api/servers/:uuid/webhooks        outgoing notifications
```

**The console does not open with an API key.** `GET /api/servers/:uuid/console` answers `403` to any
request carrying one, whatever its scopes — the route is a `GET`, so a `read` key would otherwise
reach it, and what it hands back is not a read: it is a two-minute token carrying the account's
permissions on that server, which the browser presents directly to the daemon and which the daemon
honours without asking the panel anything. Open a console from a signed-in browser.

That two-minute lifetime is also the delay before a withdrawn access stops working; see
[Securing your instance](security.md) if you are handling an incident.

## Outgoing notifications

A server's **Notifications tab**. The panel calls the address of your choice on every subscribed
event: start, stop, unexpected stop, backup and installation.

The address is checked before saving **and before every send**: those leading to an internal network
— loopback, private addresses, the cloud metadata service — are refused. Without that check, a
subuser could have the panel deliver them the contents of your network.

### Discord

Paste a channel webhook URL: the message is formatted, coloured by severity and linked to the server
in the panel. Nothing else to configure.

### Any other recipient

The body is stable JSON:

```json
{
  "event": "server.crashed",
  "occurredAt": "2026-08-04T12:00:00.000Z",
  "server": {
    "uuid": "1b32d12d-…",
    "name": "Survival",
    "address": "play.example.com:25565",
    "url": "https://panel.example.com/server/1b32d12d-…"
  },
  "details": { "Cause": "killed by the kernel, out of memory" }
}
```

Every request carries `X-Hopper-Event` and `X-Hopper-Signature`, an HMAC-SHA256 of the body.
**Verify it**: a webhook's URL always ends up circulating, and without a signature anyone could
forge alerts. The secret is readable from the interface.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
const received = request.headers['x-hopper-signature'];

// Constant-time comparison: `===` stops at the first differing byte.
const valid =
  expected.length === received.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

An address that fails twenty times in a row is paused rather than retried forever; the interface
shows the last response code and re-enables it with one click.
