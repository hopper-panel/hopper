# Security policy

Hopper runs arbitrary code (Minecraft servers and their plugins), exposes a filesystem over HTTP and
SFTP, and drives the host machine's Docker daemon. A flaw here is not limited to one game server: it
can give root access to the host.

## Reporting a vulnerability

**Do not open a public issue.**

Use the repository's **Security → Report a vulnerability** tab (GitHub Security Advisories), or write
to `security@hopperpanel.io`.

Please include:

- a description of the flaw and its impact;
- the steps to reproduce it, or a proof of concept;
- the Hopper version, the OS and the Docker version concerned.

Our commitments:

|                         |                                        |
| ----------------------- | -------------------------------------- |
| Acknowledgement         | within 48 hours                        |
| First assessment        | within 7 days                          |
| Fix for a critical flaw | within 14 days                         |
| Disclosure              | coordinated, after the fix is released |

Whoever reports a flaw is credited in the security advisory, unless they ask otherwise.

## Scope

In scope:

- **Path escape** in the file manager or over SFTP (traversal, symlinks, zip slip);
- **Container escape** or privilege escalation towards the host;
- **Authentication or authorisation bypass**, including between subusers;
- **Command injection** through startup variables or templates;
- **Token forgery**: node tokens, console JWTs, signed download URLs;
- **SSRF** from the panel towards a daemon or an internal address;
- Exposure of secrets in the logs, the API responses or the interface.

Out of scope:

- issues that require administrator access to the panel one already legitimately holds;
- an operator denying service to their own instance;
- vulnerabilities in the Minecraft servers or the plugins themselves;
- misconfigurations documented as such (for instance exposing the daemon over plain HTTP).

## Threat model

Hopper assumes **a server's user is hostile**. A server operator can upload any plugin, run any
command in their console and write any file into their volume. The following guardrails are
therefore not negotiable:

1. **Path jail.** Every file operation goes through a single abstraction that resolves the real path
   and refuses anything leaving the server's volume, symlinks included.
2. **Container hardening.** Never `--privileged`, capabilities dropped, `no-new-privileges`, a PID
   limit, and the Docker socket is never mounted into a server container.
3. **Two-part tokens.** Node tokens and API keys are stored hashed; only the public identifier is in
   the clear, and they are revocable.
4. **Short-lived console JWTs**, carrying the permissions, verified by the daemon on every
   connection.
5. **No shell.** Startup commands are templates with validated variables, never a concatenation of
   strings handed to an interpreter.

## Supported versions

While the project is pre-alpha, only the `main` branch receives security fixes. This section will be
updated when 1.0 ships.
