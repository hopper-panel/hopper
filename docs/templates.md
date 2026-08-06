# Server templates

A template describes **what a server installs and runs**: its Docker image, its install script, its
startup command and the variables the user can set. It is the equivalent of Pterodactyl's "eggs",
and the importer accepts those as they are.

The shipped catalogue covers Vanilla, Paper, Purpur, Fabric, NeoForge, Velocity and BungeeCord —
seven. Folia, Forge and Bedrock were listed here before they existed; they do not, yet. Anything
else runs through an imported egg. **Administration → Templates → Resynchronise** reinstalls it after a Hopper
update; a template edited by hand is flagged "edited" and is not overwritten.

## Importing a Pterodactyl egg

From **Administration → Templates**, upload the egg's JSON file. The importer translates the fields,
keeps the variables and their validation rules, and remembers the original egg's UUID so it is not
imported twice.

Two differences worth knowing:

- The egg's Docker images are kept as they are. An egg referencing
  `ghcr.io/pterodactyl/yolks:java_21` will keep using it — the public image exists, nothing to do,
  but you then depend on its registry.
- An egg's install scripts run in a throwaway container mounted on `/mnt/server`, exactly as under
  Pterodactyl.

## Writing a template

The shipped templates are TypeScript in `packages/templates/src/catalog/`. A minimal template:

```ts
{
  key: 'my-server',              // stable identifier: serves as the update key
  group: TEMPLATE_GROUPS.JAVA,
  name: 'My server',
  description: 'What this template installs.',

  dockerImages: JAVA_IMAGES,     // the first is offered by default
  startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
  stopCommand: 'command:stop',   // or `signal:SIGTERM`
  startupDetection: BUKKIT_STARTUP_DETECTION,

  configFiles: [SERVER_PROPERTIES_CONFIG],
  installScript: '…',            // bash, run in a throwaway container

  variables: [
    {
      name: 'Minecraft version',
      envVariable: 'MINECRAFT_VERSION',
      defaultValue: '1.21.4',
      userEditable: true,
      rules: 'required|string|max:20',
    },
  ],
}
```

### The startup command

`startup` is a **template with variables**, never a string handed to a shell. The `{{VARIABLE}}`
placeholders are replaced with validated values, then the command is split into arguments. A user
typing `server.jar; rm -rf /` into a variable would get an unusable argument, not a second command.

These variables are supplied by Hopper:

| Variable                             | Value                                                      |
| ------------------------------------ | ---------------------------------------------------------- |
| `{{SERVER_MEMORY}}`                  | Heap budget, in MiB — **lower** than the container's limit |
| `{{SERVER_IP}}`                      | IP of the primary allocation                               |
| `{{SERVER_PORT}}`                    | Port of the primary allocation                             |
| `{{server.allocations.<role>.port}}` | Port the operator named `<role>` — see below               |
| `{{server.allocations.<role>.ip}}`   | Its address                                                |

`SERVER_MEMORY` is not the container's limit: the JVM consumes beyond its heap — metaspace, thread
stacks, direct buffers — and the kernel's page cache counts towards the cgroup limit. Hopper
therefore reserves headroom, without which a 1 GiB server is killed by the kernel before it has
finished starting.

#### Naming a port in the command

A server has one primary port and any number of extra ones, and `{{SERVER_PORT}}` is the primary.
The others are reached by the name the operator gave them in the **Network** tab — the same names
`readiness` matches on, resolved the same way, so a template can knock on and listen on one port:

```ts
startup: './bin/x64/factorio --port {{SERVER_PORT}} --rcon-port {{server.allocations.rcon.port}}',
```

There is no `{{server.allocations.default.port}}`: the primary port carries no name, and asking for
one under a name a server has not got is refused rather than answered with the primary — see below.

#### A variable that does not resolve

Two things can go wrong with a variable, and they end very differently.

**A name nothing defines** — a typo, or a port nobody has named — **refuses the start.** Nothing is
created, and the console says which name went unmatched. This is not pedantry: the argument would
otherwise vanish from the command, and on a flag/value pair
(`--rcon-port {{server.allocations.rcon.port}}`) the flag left behind swallows the next argument, so
`--port 34197` becomes the RCON port and the game is given no port at all. The only symptom of that
is the game's own complaint, several lines into a console nobody has open.

**A name that is defined and empty** — `{{JAVA_FLAGS}}` with nothing in it — has its argument
dropped, as it always has: an empty argument fails a JVM, and half the imported eggs rely on the
drop. It is now said on the console. The flag in front of such an argument is _not_ dropped with it,
deliberately: nothing can tell `--rcon-port {{X}}`, where the flag is orphaned, from
`-Xmx3276M {{JAVA_FLAGS}}`, where the argument in front is complete in itself, and guessing would
delete the heap ceiling from every Minecraft server here.

### The validation rules

`rules` follows Laravel's syntax, to stay compatible with the eggs:
`required|string|max:20`, `nullable|integer|min:1|max:65535`, `required|in:true,false`.

A `userEditable` variable feeds the startup command: it is user input that influences what the JVM
runs. The default is therefore "not editable", and every exception has to be a conscious choice —
with rules narrow enough to accept only what makes sense.

### Startup detection

A server that is up is not a server that is ready. The template says how to tell the difference, and
until it does the server stays `starting` — a spinner in the panel, and no "started" notification.

`startupDetection` is the original answer: a regular expression looked for in the server's output,
promoting the server on the first match. For a Bukkit server that is `Done (12.345s)! For help, type
"help"`. It works for exactly one shape of workload, the one that announces itself on stdout in a
line you can pin down, and it holds exactly one pattern.

`readiness` is the general answer. Four strategies, and each is somebody's only option:

| Strategy    | Waits for                                     | For                                           |
| ----------- | --------------------------------------------- | --------------------------------------------- |
| `log`       | any one of several console patterns           | anything that announces itself in its output  |
| `port`      | something accepting a TCP connection          | a server that logs nothing recognisable       |
| `rcon`      | an RCON login being accepted                  | a server that answers only once it is serving |
| `immediate` | nothing at all — the container being up is it | a workload with no notion of "ready"          |

```ts
readiness: {
  type: 'log',
  // Alternatives, not steps: any one matching is enough.
  patterns: ['Hosting game at IP ADDR', 'changing state from\\(CreatingGame\\) to\\(InGame\\)'],
  timeoutMs: 300_000,     // optional — see below
},
```

`log` takes **several** patterns because one is often not enough: the announcing line moves between
builds of the same game, and a template pinning no version has to survive the build it is installed
with changing under it. Listing both wordings costs nothing; guessing which one you will get costs a
server that never leaves `starting`.

`port` is TCP only. A `udp` protocol is accepted in the field — it describes the game, not this node
— but it is never probed: a connectionless socket cannot tell a closed port from a silent one
without reading ICMP through a raw socket the daemon deliberately has no capability for. The daemon
says so on the console and calls the server running once its container is up. That is the wrong
moment, and it beats a server parked in `starting` for ever while it quietly takes players.

`rcon` names the **variable** holding the password (`secretVariable: 'RCON_PASSWORD'`), never the
password. The daemon resolves it against the server's environment when it connects.

#### Naming a port

`port` and `rcon` knock on the server's primary port unless the strategy names another one:

```ts
readiness: {
  type: 'rcon',
  role: 'rcon',                    // the port the operator named `rcon`
  secretVariable: 'RCON_PASSWORD',
  timeoutMs: 120_000,
},
```

A name is lowercase letters and digits, starting with a letter, no dots or dashes. It is a lookup
key, not a label — matched exactly, typed once by whoever names the port and once by whoever writes
the template — and it is destined to be part of a variable name too, which is what rules out the dot
in particular. The operator gives it in the server's **Network** tab; the primary port carries none, because it is
already what a strategy naming nothing resolves to and one port with two names follows the primary
around the day somebody moves it.

A role matching no port on the server is **refused**, not read as "the primary one then". Guessing
there would have the daemon speak the RCON handshake at the game port, fail every two seconds, and
at the deadline stop a server that was up and serving players — reported to its operator as a crash.
The refusal names the role and points at the Network tab, and the strategy is re-resolved on every
configuration sync, so creating the port fixes the next start with no daemon restart.

**A node too old to understand names.** `role` travels inside the server configuration, and a daemon
that predates it strips the field without a word and uses the primary port. Nothing in the payload
can warn it, so the panel asks the node what it honours — `allocation-roles`, announced by the
daemon on `/api/system` — and refuses to save a name on a node that does not. The gap left: a node
downgraded _after_ a name was saved keeps the name in the database and ignores it on the wire.

The same skew reaches the **startup command**, and there it is quieter still. A daemon that predates
names has no `{{server.allocations.<role>.port}}` either, so it drops the argument and starts the
server on a command one argument short — the very thing a current daemon refuses to do. The panel's
gate keeps a port from being _named_ on such a node, so the variable can never resolve there; a
template that references one is simply unusable on it. Until the whole fleet is upgraded, a template
meant for every node should not name a port — which is why the bundled Factorio template ships
without RCON.

**Keep `startupDetection` filled in.** A node running a daemon older than `readiness` strips the
field it does not know, without a word, and reads the deprecated one alone — so a template that drops
it calls its servers running the instant the container comes up, on exactly the machines that cannot
be upgraded in lockstep. For a `log` strategy it should be `patterns[0]`; a catalogue test enforces
both.

#### Deadlines

`timeoutMs` is optional and has **no default**, and that is the whole design: declaring it is how a
template opts into a start that can **fail**. When the deadline passes, the daemon says so on the
console, stops the server and reports the stop as one nobody asked for — a notification, not a line
in a console nobody has open.

Declaring nothing keeps the open-ended wait: the daemon goes on believing the start until something
else ends it. That is what every server did before the field existed, what the whole shipped
catalogue still does, and what an imported Pterodactyl egg does — an egg says nothing about
deadlines, so the importer invents none rather than hand a stop to a workload it has never seen.

Pick a figure from the workload, not from habit. A headless Factorio prints its hosting line in
seconds and gives up after five minutes; a modded pack loading three hundred mods needs far longer,
and a deadline shorter than its slowest honest start is a template that stops working the day
somebody adds a mod. An hour is the ceiling — past that a deadline is not one.

### The install script

It runs in an ephemeral container (`debian:bookworm-slim` by default), with the server's volume
mounted on `/mnt/server`. Its logs are streamed into the console during the installation.

Three rules learned from reading the existing scripts back:

1. `set -euo pipefail` at the top. Without it, a failed download leaves a half-filled volume and an
   installation declared successful.
2. `curl --fail`, always. PaperMC's v2 API, since it was retired, answers "200" with an error body:
   without `--fail`, you get a zero-byte `.jar` and a server that refuses to start explaining
   nothing.
3. Check what was downloaded — non-zero size, a checksum when the API publishes one.

## Configuration files

`configFiles` describes the files Hopper patches at startup, so the server really listens on the
allocation it was given. `SERVER_PROPERTIES_CONFIG` handles `server-ip`, `server-port` and
`query.port` in `server.properties`.

Without it, a player editing `server-port` in the file editor would make their server unreachable —
and the allocation the panel displays would be a lie.
