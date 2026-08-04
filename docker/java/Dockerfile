# Image d'exécution des serveurs Minecraft.
#
# Construite pour chaque version de Java supportée :
#   docker build --build-arg JAVA_VERSION=21 -t ghcr.io/hopper-panel/java:21 .
#
# Choix de conception :
#   • Debian slim plutôt qu'Alpine — Paper et surtout les modpacks Forge tirent
#     des bibliothèques natives compilées contre la glibc, que musl ne fournit
#     pas. Les plantages qui en résultent sont difficiles à diagnostiquer.
#   • Aucun outil de compilation, aucun compilateur : l'image ne sert qu'à
#     exécuter une JVM.
#   • Un utilisateur non root, dont l'UID correspond à celui des fichiers du
#     volume côté hôte.

ARG JAVA_VERSION=21
FROM eclipse-temurin:${JAVA_VERSION}-jre-noble

LABEL org.opencontainers.image.source="https://github.com/hopper-panel/hopper"
LABEL org.opencontainers.image.description="Image d'exécution Java pour Hopper Panel"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

# curl et ca-certificates : de nombreux plugins téléchargent leurs ressources au
# premier démarrage. tini : sans lui, la JVM devient PID 1 et n'adopte pas les
# processus orphelins, qui s'accumulent en zombies jusqu'à la limite de PID.
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

# tini récolte les processus orphelins et relaie correctement les signaux, ce
# qui permet à l'arrêt propre de fonctionner.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
