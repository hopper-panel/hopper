# Server templates

A template describes **what a server installs and runs**: its Docker image, its install script, its
startup command and the variables the user can set. It is the equivalent of Pterodactyl's "eggs",
and the importer accepts those as they are.

The shipped catalogue covers Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Velocity,
BungeeCord and Bedrock. **Administration → Templates → Resynchronise** reinstalls it after a Hopper
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

Three variables are supplied by Hopper:

| Variable            | Value                                                       |
| ------------------- | ----------------------------------------------------------- |
| `{{SERVER_MEMORY}}` | Heap budget, in MiB — **lower** than the container's limit  |
| `{{SERVER_IP}}`     | IP of the primary allocation                                |
| `{{SERVER_PORT}}`   | Port of the primary allocation                              |

`SERVER_MEMORY` is not the container's limit: the JVM consumes beyond its heap — metaspace, thread
stacks, direct buffers — and the kernel's page cache counts towards the cgroup limit. Hopper
therefore reserves headroom, without which a 1 GiB server is killed by the kernel before it has
finished starting.

### The validation rules

`rules` follows Laravel's syntax, to stay compatible with the eggs:
`required|string|max:20`, `nullable|integer|min:1|max:65535`, `required|in:true,false`.

A `userEditable` variable feeds the startup command: it is user input that influences what the JVM
runs. The default is therefore "not editable", and every exception has to be a conscious choice —
with rules narrow enough to accept only what makes sense.

### Startup detection

`startupDetection` is a regular expression looked for in the server's output. Until it appears the
server stays `starting`; it moves to `running` on the first match. For a Bukkit server, that is the
line `Done (12.345s)! For help, type "help"`.

Without it, the server is declared `running` as soon as the container runs — so long before it
accepts a player.

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
