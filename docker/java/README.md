# Java images

Runtime images for the Minecraft servers.

## Published versions

| Tag       | Java | Typical use                            |
| --------- | ---- | -------------------------------------- |
| `java:8`  | 8    | 1.8.x — PvP, factions, legacy networks |
| `java:11` | 11   | 1.13 – 1.16                            |
| `java:17` | 17   | 1.17 – 1.20.4                          |
| `java:21` | 21   | 1.20.5 and later, Velocity, Folia      |
| `java:25` | 25   | experimental                           |

## Building locally

```bash
docker build --build-arg JAVA_VERSION=21 -t ghcr.io/hopper-panel/java:21 docker/java
docker build --build-arg JAVA_VERSION=8  -t ghcr.io/hopper-panel/java:8  docker/java
```

## Why not Alpine

Paper and Forge modpacks load native libraries compiled against glibc. musl does
not accept them, and the failure shows up as an `UnsatisfiedLinkError` in the
middle of loading a world — unpleasant for an operator to diagnose. The few tens
of megabytes saved are not worth that risk.

## Why tini

Without it, the JVM becomes PID 1. A PID 1 does not adopt orphan processes: every
subprocess a plugin launches and then abandons stays a zombie and consumes an
entry in the process table, until `PidsLimit` is reached and the server can no
longer create a thread.

`tini -g` also relays signals to the process group, which is what makes a clean
stop actually work.

## UID and GID

The `container` user carries UID 988, aligned with `system.uid` in `daemon.yml`.
The two have to agree: otherwise the server cannot write into its own volume, or
writes files the daemon can no longer read.
