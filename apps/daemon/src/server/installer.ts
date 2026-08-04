import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ServerConfiguration } from '@hopper/shared';
import type { DockerClient } from '../docker/client.js';
import { LineAssembler } from './console-buffer.js';
import { buildEnvironment } from './invocation.js';

/**
 * Running a server's install script.
 *
 * Installation runs in a **throwaway** container, separate from the server's:
 * the script needs `curl`, `jq`, sometimes a full JDK, things that have no
 * business in a runtime image one would like minimal.
 *
 * Unlike the server container, this one runs as root — an install script often
 * begins with `apt-get install`. That is acceptable because the script comes
 * from a **template**, written by an administrator, never from a server's user.
 * The consequence — root-owned files in the volume — is corrected right after.
 */

/** Where the server's volume is mounted during installation. */
const SERVER_MOUNT = '/mnt/server';
/** Where the script is mounted, read-only. */
const SCRIPT_MOUNT = '/mnt/install';

export interface InstallationOptions {
  configuration: ServerConfiguration;
  volumePath: string;
  /** The daemon's temporary directory, where the script is dropped. */
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
 * Starts the installation and waits for it to finish.
 *
 * @throws {InstallationError} if the template describes no installation, or if
 *   Docker refuses to create the container.
 */
export async function runInstallation(
  docker: DockerClient,
  options: InstallationOptions,
): Promise<InstallationResult> {
  const { configuration, volumePath, tmpPath, ownership, networkName, onOutput } = options;
  const install = configuration.install;

  if (!install || install.script.trim() === '') {
    throw new InstallationError('This template describes no install script.');
  }

  const scriptDirectory = join(tmpPath, `install-${configuration.uuid}`);

  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(volumePath, { recursive: true });

  // Template scripts are written on Linux; a CRLF slipped in by a Windows
  // editor would produce `/bin/bash^M: bad interpreter`, a message nobody ever
  // connects back to line endings.
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
    // An array, not a string: the interpreter declared by the template gets the
    // script's path, with no extra shell layer.
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
      // Installation downloads: it needs the network, but no more privilege
      // than that.
      Privileged: false,
      // Not every capability is dropped here, unlike in the server container:
      // `apt-get` needs CHOWN, SETUID and SETGID to install its packages. The
      // trade-off is acceptable — this container runs template code only, lives
      // a few seconds, and accepts no input from a server's user.
      SecurityOpt: ['no-new-privileges'],
      // Bounded: a script downloading a 12 GiB modpack must not fill the
      // host's disk beyond what the server is entitled to.
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
    // The script ran as root: without taking ownership back, the server —
    // which runs as UID 988 — could not write into any of the files just
    // installed, and would fail on its first start with an incomprehensible
    // permission error.
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
 * Waits for a container to finish and returns its exit code.
 *
 * `Container.wait()` is typed `any` by dockerode: the typing is closed back
 * here rather than letting that value circulate. A missing code becomes -1,
 * which will be treated as a failure — the right default when in doubt.
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
      // No network: this step only fixes permissions.
      NetworkMode: 'none',
      RestartPolicy: { Name: 'no' },
    },
  });

  await container.start();
  const exitCode = await waitForExit(container);
  await container.remove({ force: true }).catch(() => undefined);

  if (exitCode !== 0) {
    options.onOutput(
      `[Hopper] Taking ownership of the files failed (code ${exitCode}). The server may not be able to write into its volume.`,
    );
  }
}

async function removeIfExists(docker: DockerClient, name: string): Promise<void> {
  try {
    await docker.api.getContainer(name).remove({ force: true });
  } catch {
    // Absent: that is the normal case.
  }
}
