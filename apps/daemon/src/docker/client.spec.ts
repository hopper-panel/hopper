import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { daemonConfigSchema } from '../config/schema.js';
import { DockerClient } from './client.js';

/**
 * These tests drive a real Docker engine.
 *
 * Nothing here was covered before, and the workflow claimed otherwise — it said
 * the daemon was tested against a real daemon through Testcontainers, of which
 * there was no dependency and no test. A green run on a dockerode upgrade
 * therefore meant TypeScript compiled, nothing more.
 *
 * A mock would not have helped. What breaks between dockerode majors is never
 * the shape of the call, it is what the engine does with it: a stream that
 * stops being consumable, a filter that stops matching, an attach that returns
 * before the container speaks. Only an engine can answer that.
 *
 * The probe is synchronous and at module level, like the symlink probe in
 * `jailed-filesystem.spec.ts`: `describe.runIf` is evaluated while Vitest
 * collects, before any `beforeAll` runs, so an asynchronous probe would leave
 * the flag false everywhere and the tests would report as skipped on machines
 * that could have run them.
 */
const dockerSocket = ((): string | null => {
  const candidates =
    process.platform === 'win32'
      ? ['//./pipe/docker_engine']
      : ['/var/run/docker.sock', '/run/docker.sock'];

  for (const socket of candidates) {
    try {
      execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return socket;
    } catch {
      // No engine, or no client to ask: the suite is skipped rather than failed.
    }
  }

  return null;
})();

afterAll(() => {
  if (!dockerSocket) {
    process.stderr.write(
      '\n⚠ No Docker engine reachable: the DockerClient tests were skipped.\n' +
        '  They run in continuous integration, where the runner provides one.\n\n',
    );
  }
});

/** A tiny image, and one that exists on both architectures the project targets. */
const TEST_IMAGE = 'alpine:3.20';
const NETWORK = 'hopper-test-net';

function makeClient(): DockerClient {
  const config = daemonConfigSchema.parse({
    uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    tokenId: 'a'.repeat(16),
    tokenSecret: 'b'.repeat(64),
    panel: { url: 'http://127.0.0.1:8080', jwtSecret: 'c'.repeat(32) },
    docker: {
      socket: dockerSocket ?? '',
      // A range of its own, away from the default the daemon ships: these tests
      // run on machines that may already host a real Hopper network, and
      // colliding with it would take its servers off the network.
      network: { name: NETWORK, subnet: '172.31.250.0/24', gateway: '172.31.250.1' },
    },
  });

  const silent = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  return new DockerClient(config, silent as never);
}

describe.runIf(dockerSocket)('DockerClient against a real engine', () => {
  let client: DockerClient;

  beforeAll(() => {
    client = makeClient();
  });

  afterEach(async () => {
    // Each test cleans up after itself: a leftover network makes the next run
    // take the "already present" branch and prove nothing.
    await client.api
      .getNetwork(NETWORK)
      .remove()
      .catch(() => undefined);
  });

  it('reaches the engine', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('reports the engine version and its storage layout', async () => {
    const info = await client.info();

    expect(info.version).toMatch(/^\d+\./);
    expect(info.storageDriver).not.toBe('unknown');
    // cgroup v2 is what the memory and CPU limits are written for; a host on v1
    // silently applies none of them.
    expect(['1', '2']).toContain(info.cgroupVersion);
  });

  describe('the dedicated network', () => {
    it('creates it when it is missing', async () => {
      await client.ensureNetwork();

      const networks = await client.api.listNetworks({ filters: { name: [NETWORK] } });

      expect(networks.some((network) => network.Name === NETWORK)).toBe(true);
    });

    // Inter-container communication is off on purpose: on the default bridge a
    // server can scan and reach its neighbours' internal ports. A silent change
    // to this option would open every server to every other.
    it('turns inter-container communication off', async () => {
      await client.ensureNetwork();

      const network = await client.api.getNetwork(NETWORK).inspect();

      expect(network.Options?.['com.docker.network.bridge.enable_icc']).toBe('false');
    });

    it('is a no-op the second time', async () => {
      await client.ensureNetwork();
      await expect(client.ensureNetwork()).resolves.toBeUndefined();
    });
  });

  describe('pulling an image', () => {
    it('returns without a download when the image is present', async () => {
      await client.pullImage(TEST_IMAGE);

      const lines: string[] = [];
      await client.pullImage(TEST_IMAGE, (line) => lines.push(line));

      // A present image must not be pulled again: on a node starting twenty
      // servers, re-reading every layer from the registry would turn a restart
      // into a download.
      expect(lines).toHaveLength(0);
    }, 120_000);

    // The progress stream has to be consumed to the end, or the HTTP request
    // stays open and the download stalls halfway — a failure that looks like a
    // slow registry rather than a bug.
    it('drains the progress stream', async () => {
      await client.api
        .getImage(TEST_IMAGE)
        .remove({ force: true })
        .catch(() => undefined);

      await expect(client.pullImage(TEST_IMAGE)).resolves.toBeUndefined();

      const images = await client.api.listImages({ filters: { reference: [TEST_IMAGE] } });
      expect(images.length).toBeGreaterThan(0);
    }, 180_000);

    // "denied" alone says neither which image nor why. The message has to name
    // it, or an operator spends half an hour guessing.
    it('names the image it could not download', async () => {
      await expect(client.pullImage('ghcr.io/hopper-panel/does-not-exist:1')).rejects.toThrow(
        /does-not-exist/,
      );
    }, 60_000);
  });

  describe('managed containers', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    let containerId: string | null = null;

    afterEach(async () => {
      if (containerId) {
        await client.api
          .getContainer(containerId)
          .remove({ force: true })
          .catch(() => undefined);
        containerId = null;
      }
    });

    it('finds them by label, keyed on the server uuid', async () => {
      await client.pullImage(TEST_IMAGE);

      const container = await client.api.createContainer({
        Image: TEST_IMAGE,
        name: `hopper-${uuid}`,
        Cmd: ['sh', '-c', 'sleep 30'],
        Labels: { 'io.hopper.managed': 'true', 'io.hopper.server': uuid },
      });

      containerId = container.id;

      const managed = await client.listManagedContainers();

      expect(managed.has(uuid)).toBe(true);
    }, 120_000);

    // A container without the labels belongs to someone else on this host, and
    // the daemon must never touch it.
    it('ignores containers it does not manage', async () => {
      await client.pullImage(TEST_IMAGE);

      const container = await client.api.createContainer({
        Image: TEST_IMAGE,
        name: 'not-a-hopper-container',
        Cmd: ['sh', '-c', 'sleep 30'],
      });

      containerId = container.id;

      const managed = await client.listManagedContainers();

      expect([...managed.values()].some((info) => info.Id === container.id)).toBe(false);
    }, 120_000);
  });
});
