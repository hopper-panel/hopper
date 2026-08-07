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
  stopCommand: 'command:stop',   // or `signal:SIGTERM`, or a structured `stop` — see below
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

### Stopping the server

A stop is a save. The template says how to ask for one, and getting it wrong does not look like a
bug — it looks like a world that is an hour old.

`stopCommand` is the original answer, a colon-encoded pair:

```ts
stopCommand: 'command:stop',      // written to the server's standard input
stopCommand: 'signal:SIGTERM',    // signalled to PID 1 of the container
```

Both answer for Minecraft and for very little else. **Rust, ARK, Palworld and most Source servers
read no standard input at all**: `command:stop` writes into a pipe nobody is holding, nothing
happens for the whole timeout, and the server is SIGKILLed — a "clean stop" that is a kill with
extra waiting. `signal:` was the alternative, and a signal is a request the game may handle, ignore,
or handle by exiting without writing its world.

`stop` is the general answer, and its third transport is the reason it exists:

```ts
stop: {
  type: 'rcon',
  command: 'quit',                 // the game's own shutdown command
  role: 'rcon',                    // optional — the port named `rcon`
  secretVariable: 'RCON_PASSWORD', // the variable's NAME, never the password
},
```

The daemon connects, authenticates, sends that one command and then waits for the process exactly as
it does for the other two. Which command depends on the game: `quit` for Rust and Factorio, `DoExit`
for ARK, `shutdown 30 Restarting` for Palworld, `stop` for Minecraft. It is sent as written — nothing
in the daemon knows which game is on the other end, so nothing adds a leading slash or a save
beforehand.

`role` names the port the same way a readiness strategy does, with the same refusal: a role matching
no port on the server is refused, never read as "the primary one then". `secretVariable` names the
**variable**, resolved against the server's environment at the moment of connecting — a stop
configuration holding a password would be a password in every payload the panel sends and every log
line that printed one.

`stopCommand` stays filled in beside it. It is what the panel falls back to if the structured field
is ever cleared, and every existing template and imported egg carries nothing else.

#### A stop that cannot be delivered is refused, not forced

Four things can go wrong before the command reaches the game: the role names no port, the variable
holds no password, the password is refused, nothing accepts the connection. In all four the server
has been told **nothing** — it is running exactly as it was, with its world in memory.

So the daemon refuses instead of falling through to the SIGKILL the other transports end in. It says
on the console what to fix, says the server is still running, and leaves it running. Killing a
process that was never asked to stop loses the whole session and buys nothing; the operator asked for
a stopped server and would get a damaged one. The forceful answer already exists, one button away and
labelled **Kill** — what this refuses is to take that decision on somebody's behalf over a mistyped
variable name.

The line is delivery, not success. Once the command is acknowledged, the timeout below and the
SIGKILL after it apply exactly as they do to a stdin command that was read and ignored.

#### Declaring an RCON stop also moves the console

A server that reads no standard input reads none of it for the console either. Declaring `stop.type:
'rcon'` therefore routes **console commands** the same way — same port, same password variable — and
that is the whole declaration. There is no second field for it: repeating a port name and a password
variable in two places has exactly one interesting state, which is disagreeing, and the symptom would
be a server that stops perfectly and a console that reaches nobody.

Before this, those servers had a console that appeared to work. Every command went down the
container's attach stream into a pty nothing was reading, the write succeeded — a write to a socket
does — and the panel reported it as sent. A scheduled task running `save-all` and announcing a
restart was a no-op recorded as having run.

Two things follow, and both are visible in the console:

- **RCON answers.** stdin returns nothing; RCON returns the body the command produced. It appears on
  the console prefixed `[RCON]`, preceded by an echo of the command itself — `[RCON] > list` — because
  these games log nothing when a command is issued, so without the echo an operator watches their own
  commands vanish and never sees a scheduled one at all. A command the server acknowledged with no
  output says so rather than printing a blank line.
- **An undelivered command fails.** The same four faults as above, and the same refusal: nothing is
  sent, the console names what to fix, and the call fails. That failure travels — HTTP 502 from the
  daemon, carrying its sentence, into the schedule's audit record — so a nightly task whose commands
  reached nobody is a run with a named failure rather than a run that looks like every other one.

Nothing about permissions moves: sending a command is still gated on `control.console`, and the
answers ride the same console stream that already carries every byte the server prints.

Declaring `command:` or `signal:` leaves the console on standard input, which is right for Minecraft
— it reads stdin _and_ speaks RCON, and the channel that needs no password is the better of the two.

#### The stop timeout

```ts
stopTimeoutSeconds: 240,   // optional — the contract's default is 30
```

Thirty seconds is a Bukkit figure: a Minecraft server flushes the regions it has dirtied in a second
or two. It is the wrong figure for a game that serialises its **whole world** on shutdown, and that
is every game the RCON transport exists for — the time taken scales with the world, not with what has
recently changed. When it expires the kernel cuts the process mid-write, and what comes back is the
last autosave.

Size it from what being wrong costs in each direction. Too long is an operator watching a stopping
server for a few extra minutes, once, with Kill available. Too short is silent data loss on a server
that was shutting down correctly. Ten minutes is the ceiling.

A template that says nothing keeps the 30 every server has run on since the first release.

#### A node too old to understand an RCON stop

Worse than the skew on named ports, and worth stating plainly. `stop` is a discriminated union, so a
daemon that knows only `command` and `signal` does not strip the field — it **fails to parse the
whole server configuration**. Configurations are fetched a page at a time, so one such server makes
the page unreadable and the node ends up knowing about none of its servers: every console answers
"server unknown to this node", every power action fails, and the containers go on running with
nothing driving them.

Nothing in the payload can warn anybody, so the panel asks first. A daemon that honours this
announces `rcon-stop` on `/api/system`, and the panel refuses to create a server from such a template
on a node that does not — and refuses to transfer one there. An unreachable node is refused too.

Two gaps, left open on purpose because both need the capability re-checked when a configuration is
pushed rather than when a server is placed: a node **downgraded** after such a server was created,
and a template **edited** into an RCON stop once its servers already exist.

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

#### Where a download goes, and what bounds it

Nothing does. Neither `/tmp` nor `/mnt/server` carries a quota the kernel enforces: `/tmp` is the
container's own layer, which lives under Docker's data root on the host — `/var/lib/docker` unless
the operator moved it — and `/mnt/server` is a bind mount of the volume. The server's `diskBytes` limit is Hopper's accounting, applied to the file manager and to
SFTP — the install script is running as root under neither. A script that downloads two hundred
gigabytes writes two hundred gigabytes, and a full node takes every server on it down together.

So the fourth rule is yours to keep: **download what you need and delete what you staged.** A modpack
archive unpacked into `/mnt/server` and then left next to its own contents doubles the server's real
footprint for no reason.

Either directory works for staging, and `/tmp` is the tidier of the two: it goes away with the
container, so a failed install leaves nothing behind in the volume for the next one to trip over. It
is also the likelier of the two to run short — the container layer shares Docker's data root with
every image and every other container on the node, while `/mnt/server` may have been given a disk of
its own — so stage a very large download in `/mnt/server` and unpack it in place.

A bounded `/tmp` was tried and removed. It could not close the hole, since the volume beside it has
no ceiling either, and it broke the commonest shape there is — `curl -o /tmp/pack.zip … && unzip` —
with a limit no template could declare.

#### The inactivity deadline

```ts
installInactivityTimeoutMs: 900_000,   // optional — the daemon's own figure is 15 minutes
```

A deadline on **inactivity**, not on how long the installation takes. Nothing caps total duration: an
anonymous Steam depot takes an hour and is perfectly healthy throughout, and a cap large enough to
let it finish would never fire on anything, while one small enough to be useful would kill it.

It is not a deadline on **output** either, and that distinction is the one to hold on to when sizing
the figure. Every script in this catalogue downloads with `curl -sSL`, and `-s` suppresses the
progress meter: a two-gigabyte transfer prints nothing at all from the first byte to the last. So
what Hopper watches is what the container _does_ — the CPU it burns, the blocks it reads and writes,
and its output. A container doing none of the three is not slow, it is finished.

Those two counters are the kernel's own accounting for that container's cgroup, which is why a
silent download is never mistaken for a dead one: taking bytes off a socket and putting them on a
disk is work, and work is CPU time, however little of it a trickle costs. What is deliberately _not_
watched is the container's network counters. They count frames its interface accepted rather than
work it did, and a node's servers all share one bridge — a bridge floods broadcast ARP to every port
on it — so a container that has stopped dead still shows traffic, and a deadline fed on that would
never fire on a busy node.

The window is pushed back by any of the three. Output is taken from the raw stream rather than from
complete lines, so a progress bar rewriting one line with carriage returns counts too; the counters
are read from `docker stats` every fifteen seconds at the slowest, and every quarter of the window
wherever that is shorter — so a window under a minute is sampled more often than fifteen seconds,
down to a floor of one second. Below a four-second window the floor wins and the quarter stops
holding, which is a window too short to judge an installation on in any case. Reading the counters
rarely cannot miss activity, whatever the period works out at, because they only ever grow.

When the window expires the install container is stopped and removed and the server lands in
`install_failed` with Reinstall available. What the console says depends on whether there was
anything to see. With at least one counter sample back inside that window it names what stood still
and for how long. With none at all it says that instead, and points at this node's Docker rather
than at the script — which may have been running perfectly, and which a stall message would have
sent its author combing through for nothing.

Raise it for a script that genuinely idles — a wait on an external job, a licence check against a
slow endpoint, anything with a long `sleep` in it, since a sleeping container is doing nothing by
this definition and is meant to be. Lower it for a download that should never pause. Six hours is
the ceiling, and a template asking for more fails validation rather than being quietly capped. A
template that says nothing gets a quarter of an hour, which is chosen to be ignored by anything that
works.

An older daemon ignores the field and waits for ever, as every daemon did before this existed.
Nothing is refused over it.

#### How much disk the installation needs

```ts
installRequiredDiskBytes: 40 * 1024 ** 3,   // optional — only when the figure is knowable
```

Checked before the install container is created, and a shortfall is **refused** with both figures
named. A depot larger than the node's free space fills the host disk, and that takes down every
server on the machine.

Checked against the free space on the volume's filesystem _plus what that volume already holds_,
because a reinstall writes over what is there — nothing wipes the volume first. Demanding the whole
requirement as free space would mean a 40 GiB server could never be reinstalled on the node it is
already installed on. The floor below is the exception: that one is measured against free space
alone, since a nearly full node is nearly full whatever a single volume holds.

The volume's filesystem is the only one measured, and a refusal says so. A script that stages its
download in `/tmp` writes to the container layer instead, under Docker's storage — the same
filesystem on most nodes, a different one wherever an operator gave the volumes a disk of their own.
Declare what you download, and stage large downloads in `/mnt/server` where the check applies.

Declare it when the size is knowable and large — a Steam depot's is on the store page. Leave it out
when it is not: a Minecraft server's size is whatever modpack the operator's variables point at, and
a guess here refuses installations that would have worked. Templates that say nothing still cannot
install onto a node with nothing left, because Hopper requires a floor of free space from every
installation.

It is not the server's disk limit. That number is what the operator sells, weighed once already at
creation against the node's declared capacity and its overallocation setting; a 50 GiB plan that
will use 900 MiB has no business refusing to install on a node with 20 GiB free.

## Configuration files

`configFiles` describes the files Hopper patches at startup, so the server really listens on the
allocation it was given. `SERVER_PROPERTIES_CONFIG` handles `server-ip`, `server-port` and
`query.port` in `server.properties`.

Without it, a player editing `server-port` in the file editor would make their server unreachable —
and the allocation the panel displays would be a lie.
