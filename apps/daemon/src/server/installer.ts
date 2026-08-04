import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ServerConfiguration } from '@hopper/shared';
import type { DockerClient } from '../docker/client.js';
import { LineAssembler } from './console-buffer.js';
import { buildEnvironment } from './invocation.js';

/**
 * Exécution du script d'installation d'un serveur.
 *
 * L'installation tourne dans un conteneur **jeté après usage**, distinct de
 * celui du serveur : le script a besoin de `curl`, `jq`, parfois d'un JDK
 * complet, choses qui n'ont rien à faire dans une image d'exécution qu'on
 * voudrait minimale.
 *
 * Contrairement au conteneur de serveur, celui-ci tourne en root — un script
 * d'installation commence souvent par `apt-get install`. C'est acceptable
 * parce que le script vient d'un **template**, écrit par un administrateur,
 * jamais d'un utilisateur de serveur. La conséquence — des fichiers appartenant
 * à root dans le volume — est corrigée juste après.
 */

/** Où le volume du serveur est monté pendant l'installation. */
const SERVER_MOUNT = '/mnt/server';
/** Où le script est monté, en lecture seule. */
const SCRIPT_MOUNT = '/mnt/install';

export interface InstallationOptions {
  configuration: ServerConfiguration;
  volumePath: string;
  /** Répertoire temporaire du daemon, pour y déposer le script. */
  tmpPath: string;
  ownership: { uid: number; gid: number };
  networkName: string;
  onOutput: (line: string) => void;
}

export interface InstallationResult {
  successful: boolean;
  exitCode: number;
}

export class InstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationError';
  }
}

function installContainerName(uuid: string): string {
  return `hopper-install-${uuid}`;
}

/**
 * Lance l'installation et attend sa fin.
 *
 * @throws {InstallationError} si le template ne décrit aucune installation, ou
 *   si Docker refuse de créer le conteneur.
 */
export async function runInstallation(
  docker: DockerClient,
  options: InstallationOptions,
): Promise<InstallationResult> {
  const { configuration, volumePath, tmpPath, ownership, networkName, onOutput } = options;
  const install = configuration.install;

  if (!install || install.script.trim() === '') {
    throw new InstallationError("Ce template ne décrit aucun script d'installation.");
  }

  const scriptDirectory = join(tmpPath, `install-${configuration.uuid}`);

  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(volumePath, { recursive: true });

  // Les scripts de template sont écrits sous Linux ; un CRLF glissé par un
  // éditeur Windows produirait `/bin/bash^M: bad interpreter`, message que
  // personne ne relie jamais à des fins de ligne.
  await writeFile(join(scriptDirectory, 'install.sh'), install.script.replace(/\r\n/g, '\n'), {
    mode: 0o755,
  });

  await docker.pullImage(install.containerImage, onOutput);
  await removeIfExists(docker, installContainerName(configuration.uuid));

  const environment = buildEnvironment({
    environment: configuration.environment,
    memoryMib: Math.floor(configuration.build.memoryBytes / (1024 * 1024)),
    ip: configuration.allocations.default.ip,
    port: configuration.allocations.default.port,
  });

  const container = await docker.api.createContainer({
    name: installContainerName(configuration.uuid),
    Image: install.containerImage,
    // Un tableau, pas une chaîne : c'est l'interpréteur déclaré par le template
    // qui reçoit le chemin du script, sans couche de shell supplémentaire.
    Cmd: [install.entrypoint, `${SCRIPT_MOUNT}/install.sh`],
    Env: [...environment, `SERVER_MEMORY=${Math.floor(configuration.build.memoryBytes / 1048576)}`],
    WorkingDir: SERVER_MOUNT,
    Tty: true,
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      'io.hopper.managed': 'true',
      'io.hopper.install': configuration.uuid,
    },
    HostConfig: {
      Binds: [`${volumePath}:${SERVER_MOUNT}:rw`, `${scriptDirectory}:${SCRIPT_MOUNT}:ro`],
      NetworkMode: networkName,
      // L'installation télécharge : elle a besoin du réseau, mais pas de plus
      // de privilèges que ça.
      Privileged: false,
      // Les capabilities ne sont pas toutes retirées ici, contrairement au
      // conteneur de serveur : `apt-get` a besoin de CHOWN, SETUID et SETGID
      // pour installer ses paquets. Le compromis est acceptable — ce conteneur
      // n'exécute que du code de template, vit quelques secondes, et n'accepte
      // aucune entrée d'un utilisateur de serveur.
      SecurityOpt: ['no-new-privileges'],
      // Bornée : un script qui télécharge un modpack de 12 Gio ne doit pas
      // remplir le disque de l'hôte au-delà de ce que le serveur a droit.
      Memory: configuration.build.memoryBytes || undefined,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '1' } },
    },
  });

  const stream = (await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  })) as unknown as Duplex;

  const assembler = new LineAssembler();
  stream.on('data', (chunk: Buffer) => {
    assembler.push(chunk.toString('utf8')).forEach(onOutput);
  });

  await container.start();

  const exitCode = await waitForExit(container);
  assembler.flush().forEach(onOutput);

  await container.remove({ force: true }).catch(() => undefined);
  await rm(scriptDirectory, { recursive: true, force: true });

  if (exitCode === 0) {
    // Le script a tourné en root : sans cette reprise de propriété, le serveur
    // — qui tourne en UID 988 — ne pourrait écrire dans aucun des fichiers
    // qu'on vient d'installer, et échouerait au premier démarrage avec une
    // erreur de permission incompréhensible.
    await reclaimOwnership(docker, {
      image: install.containerImage,
      volumePath,
      ownership,
      onOutput,
    });
  }

  return { successful: exitCode === 0, exitCode };
}

/**
 * Attend la fin d'un conteneur et retourne son code de sortie.
 *
 * `Container.wait()` est typé `any` par dockerode : on referme le typage ici
 * plutôt que de laisser cette valeur circuler. Un code absent devient -1, qui
 * sera traité comme un échec — c'est le bon défaut quand on ne sait pas.
 */
async function waitForExit(container: { wait: () => Promise<unknown> }): Promise<number> {
  const result = (await container.wait()) as { StatusCode?: unknown };
  return typeof result?.StatusCode === 'number' ? result.StatusCode : -1;
}

async function reclaimOwnership(
  docker: DockerClient,
  options: {
    image: string;
    volumePath: string;
    ownership: { uid: number; gid: number };
    onOutput: (line: string) => void;
  },
): Promise<void> {
  const container = await docker.api.createContainer({
    Image: options.image,
    Cmd: ['chown', '-R', `${options.ownership.uid}:${options.ownership.gid}`, SERVER_MOUNT],
    HostConfig: {
      Binds: [`${options.volumePath}:${SERVER_MOUNT}:rw`],
      // Aucun réseau : cette étape ne fait que corriger des permissions.
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
    },
  });

  await container.start();
  const exitCode = await waitForExit(container);
  await container.remove({ force: true }).catch(() => undefined);

  if (exitCode !== 0) {
    options.onOutput(
      `[Hopper] Reprise de propriété des fichiers échouée (code ${exitCode}). Le serveur risque de ne pas pouvoir écrire dans son volume.`,
    );
  }
}

async function removeIfExists(docker: DockerClient, name: string): Promise<void> {
  try {
    await docker.api.getContainer(name).remove({ force: true });
  } catch {
    // Absent : c'est le cas normal.
  }
}
