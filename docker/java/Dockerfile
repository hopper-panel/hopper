# Runtime image for the Minecraft servers.
#
# Built for every supported Java version:
#   docker build --build-arg JAVA_VERSION=21 -t ghcr.io/hopper-panel/java:21 .
#
# Design choices:
#   • Debian slim rather than Alpine — Paper, and Forge modpacks above all, pull
#     native libraries compiled against glibc, which musl does not provide. The
#     crashes that follow are hard to diagnose.
#   • No build tooling, no compiler: the image only ever runs a JVM.
#   • A non-root user, whose UID matches that of the files in the volume on the
#     host side.

ARG JAVA_VERSION=21
FROM eclipse-temurin:${JAVA_VERSION}-jre-noble

LABEL org.opencontainers.image.source="https://github.com/hopper-panel/hopper"
LABEL org.opencontainers.image.description="Java runtime image for Hopper Panel"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

# curl and ca-certificates: many plugins download their resources on first
# start. tini: without it the JVM becomes PID 1 and does not adopt orphan
# processes, which pile up as zombies until the PID limit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tini \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

ARG CONTAINER_UID=988
ARG CONTAINER_GID=988

RUN groupadd --gid ${CONTAINER_GID} container \
 && useradd --uid ${CONTAINER_UID} --gid ${CONTAINER_GID} \
      --home-dir /home/container --create-home --shell /usr/sbin/nologin container

USER container
ENV USER=container HOME=/home/container
WORKDIR /home/container

# tini reaps the orphan processes and relays signals properly, which is what
# makes the clean stop work.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
