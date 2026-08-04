# Images Java

Images d'exécution des serveurs Minecraft.

## Versions publiées

| Tag       | Java | Usage typique                          |
| --------- | ---- | -------------------------------------- |
| `java:8`  | 8    | 1.8.x — PvP, faction, réseaux legacy   |
| `java:11` | 11   | 1.13 – 1.16                            |
| `java:17` | 17   | 1.17 – 1.20.4                          |
| `java:21` | 21   | 1.20.5 et ultérieures, Velocity, Folia |
| `java:25` | 25   | expérimental                           |

## Construction locale

```bash
docker build --build-arg JAVA_VERSION=21 -t ghcr.io/hopper-panel/java:21 docker/java
docker build --build-arg JAVA_VERSION=8  -t ghcr.io/hopper-panel/java:8  docker/java
```

## Pourquoi pas Alpine

Paper et les modpacks Forge chargent des bibliothèques natives compilées contre
la glibc. musl ne les accepte pas, et l'échec se manifeste par un
`UnsatisfiedLinkError` au milieu du chargement d'un monde — pénible à
diagnostiquer pour un opérateur. Les quelques dizaines de mégaoctets économisés
ne valent pas ce risque.

## Pourquoi tini

Sans lui, la JVM devient PID 1. Un PID 1 n'adopte pas les processus orphelins :
chaque sous-processus lancé par un plugin puis abandonné reste en zombie et
consomme une entrée de la table des processus, jusqu'à ce que `PidsLimit` soit
atteinte et que le serveur ne puisse plus créer de thread.

`tini -g` relaie aussi les signaux au groupe de processus, ce qui rend l'arrêt
propre effectif.

## UID et GID

L'utilisateur `container` porte l'UID 988, aligné sur `system.uid` de
`daemon.yml`. Les deux doivent concorder : sinon le serveur ne peut pas écrire
dans son propre volume, ou écrit des fichiers que le daemon ne sait plus lire.
