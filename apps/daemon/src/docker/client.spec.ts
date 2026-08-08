import { execFileSync } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonConfigSchema } from '../config/schema.js';
import {
  boundEveryRequest,
  DockerClient,
  DOCKER_ANSWER_TIMEOUT_MS,
  DockerUnansweredError,
  dockerRequestTimeout,
  ICC_OPTION,
  NETWORK_ISOLATION_REPEAT_MS,
  networkIsolationOf,
  PULL_STALL_TIMEOUT_MS,
  type DockerRequest,
} from './client.js';

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

/**
 * A logger that keeps what it was told.
 *
 * Used by the tests that check the daemon *says* something, which for a hole it
 * has decided not to close on its own is the entire remedy: a verdict nobody is
 * told about is the same as no verdict.
 */
function recorder(): { logger: unknown; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  return {
    errors,
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (_context: unknown, message?: string) => warnings.push(message ?? ''),
      error: (_context: unknown, message?: string) => errors.push(message ?? ''),
    },
  };
}

/**
 * The de-duplication of the isolation report, which is a balance rather than a
 * rule and so is pinned in both directions.
 *
 * Too quiet and a hole announces itself once, at a start nobody watched, then
 * never again — the report is the entire remedy for a fault the daemon
 * deliberately does not repair. Too loud and "still fine" every half hour is
 * what teaches an operator to filter these lines out, taking the one line that
 * mattered with them.
 *
 * Driven through `checkNetworkIsolation` on a client whose socket does not
 * exist, so no engine is involved: an unreachable Docker answers `unknown`,
 * which is a non-isolated status and therefore repeats, exactly as `open` does.
 */
describe('reporting an isolation verdict more than once', () => {
  const nowhere = '/var/run/hopper-no-such-docker.sock';

  it('says it once, not on every measurement', async () => {
    const log = recorder();
    const client = makeClient(nowhere, log.logger);

    await client.checkNetworkIsolation();
    await client.checkNetworkIsolation();
    await client.checkNetworkIsolation();

    expect(log.warnings).toHaveLength(1);
  });

  it('says it again once the repeat window has passed', async () => {
    vi.useFakeTimers();

    try {
      const log = recorder();
      const client = makeClient(nowhere, log.logger);

      await client.checkNetworkIsolation();
      vi.setSystemTime(Date.now() + NETWORK_ISOLATION_REPEAT_MS + 1);
      await client.checkNetworkIsolation();

      expect(log.warnings).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not say it again a moment before the window is up', async () => {
    vi.useFakeTimers();

    try {
      const log = recorder();
      const client = makeClient(nowhere, log.logger);

      await client.checkNetworkIsolation();
      vi.setSystemTime(Date.now() + NETWORK_ISOLATION_REPEAT_MS - 1000);
      await client.checkNetworkIsolation();

      expect(log.warnings).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function makeClient(socket: string | null = dockerSocket, logger?: unknown): DockerClient {
  const config = daemonConfigSchema.parse({
    uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    tokenId: 'a'.repeat(16),
    tokenSecret: 'b'.repeat(64),
    panel: { url: 'http://127.0.0.1:8080', jwtSecret: 'c'.repeat(32) },
    docker: {
      socket: socket ?? '',
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

  return new DockerClient(config, (logger ?? silent) as never);
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

    it('reports a network it has just created as isolating the servers', async () => {
      await client.ensureNetwork();

      // Measured through Docker rather than assumed from the option that was
      // sent: what is claimed to operators is what the engine says, not what
      // this file believes it asked for.
      await expect(client.checkNetworkIsolation()).resolves.toMatchObject({
        network: NETWORK,
        status: 'isolated',
      });
    });

    /**
     * **The hole this whole file was reopened for.**
     *
     * `ensureNetwork` used to return the instant it saw a network by the right
     * name, without looking at a single one of its options. So a `hopper0`
     * created by a bare `docker network create` — by an operator following half
     * a runbook, by a Hopper older than the option, or restored with a machine
     * image — left inter-container traffic on, and every server on the node
     * could reach every other one's RCON. Nothing said so anywhere.
     *
     * The two assertions are the two halves of the decision: it is *detected*,
     * and it is *not repaired behind the operator's back* — recreating the
     * network would disconnect every container on the machine.
     */
    it('sees through a network that already existed with the wrong options', async () => {
      const preexisting = await client.api.createNetwork({ Name: NETWORK, Driver: 'bridge' });

      await expect(client.ensureNetwork()).resolves.toBeUndefined();

      await expect(client.checkNetworkIsolation()).resolves.toMatchObject({
        network: NETWORK,
        status: 'open',
      });

      // The same network, untouched: no silent teardown of everything running
      // on this node in the name of fixing it.
      const after = await client.api.getNetwork(NETWORK).inspect();
      expect(after.Id).toBe(preexisting.id);
    });

    // A verdict nobody is told about is not a verdict. This is the whole
    // remedy for a hole the daemon deliberately leaves open, so it is asserted
    // rather than assumed: the line names the network and the command that
    // fixes it.
    it('says so, loudly, when it finds one', async () => {
      const log = recorder();
      const loud = makeClient(dockerSocket, log.logger);

      await loud.api.createNetwork({ Name: NETWORK, Driver: 'bridge' });
      await loud.ensureNetwork();

      expect(log.errors).toHaveLength(1);
      expect(log.errors[0]).toContain(NETWORK);
      expect(log.errors[0]).toContain('NOT isolated');
      expect(log.errors[0]).toContain(`docker network rm ${NETWORK}`);
    });

    // Removed under a running daemon: a definite answer from Docker, and still
    // not evidence that anything is misconfigured. It must not read as "open".
    it('says it cannot tell rather than accusing a network that is gone', async () => {
      await client.ensureNetwork();
      await client.api.getNetwork(NETWORK).remove();

      const verdict = await client.checkNetworkIsolation();

      expect(verdict.status).toBe('unknown');
      expect(verdict.detail).toContain('does not exist');
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

/**
 * What a network's options are read to mean, read as a rule.
 *
 * Pure, so the two answers that matter can be asked without an engine: a
 * network created *by something other than this daemon*, which is the only way
 * the hole ever appears, and a driver on which the option means nothing. No
 * test against a network `ensureNetwork` created could reach either.
 */
describe('reading a network as isolating or not', () => {
  const bridge = (options?: Record<string, string>) => ({ Driver: 'bridge', Options: options });

  it('trusts the option this daemon sets', () => {
    expect(networkIsolationOf('hopper0', bridge({ [ICC_OPTION]: 'false' }))).toMatchObject({
      status: 'isolated',
    });
  });

  /**
   * **Silence is the dangerous answer here, not the neutral one.** A bare
   * `docker network create hopper0` writes no `enable_icc` key at all, and
   * Docker's default is to let containers talk. Reading an absent option as
   * "probably fine" would be reading the exact shape of the bug as healthy.
   */
  it('reads an absent option as traffic allowed', () => {
    const verdict = networkIsolationOf('hopper0', bridge({}));

    expect(verdict.status).toBe('open');
    expect(verdict.detail).toContain('not set');
  });

  it('reads an option turned on as traffic allowed', () => {
    expect(networkIsolationOf('hopper0', bridge({ [ICC_OPTION]: 'true' }))).toMatchObject({
      status: 'open',
    });
  });

  /**
   * Parsed the way Docker parses it rather than compared to the string this
   * daemon happens to write. An operator who created the network with
   * `--opt …enable_icc=0` really did turn the traffic off, and reporting that
   * node as wide open would be a false accusation about a correct machine —
   * which is the failure mode this whole check has to avoid to be worth having.
   */
  it.each(['0', 'f', 'F', 'FALSE', 'False'])('accepts %s as Docker does', (value) => {
    expect(networkIsolationOf('hopper0', bridge({ [ICC_OPTION]: value })).status).toBe('isolated');
  });

  it.each(['1', 't', 'TRUE', 'True'])('accepts %s as Docker does', (value) => {
    expect(networkIsolationOf('hopper0', bridge({ [ICC_OPTION]: value })).status).toBe('open');
  });

  // `enable_icc` is a bridge-driver option and nothing else reads it: on a
  // macvlan or an overlay wearing this name the containers see one another
  // whatever the options say.
  it('reads a network that is not a bridge as traffic allowed', () => {
    const verdict = networkIsolationOf('hopper0', {
      Driver: 'macvlan',
      Options: { [ICC_OPTION]: 'false' },
    });

    expect(verdict.status).toBe('open');
    expect(verdict.detail).toContain('macvlan');
  });

  // A value neither Docker nor this daemon can parse cannot be shown to mean
  // "off", and the guess is made in the direction that gets looked at.
  it('does not read a value it cannot parse as off', () => {
    expect(networkIsolationOf('hopper0', bridge({ [ICC_OPTION]: 'maybe' })).status).toBe('open');
  });
});

/**
 * A registry that accepts the connection and then stops sending.
 *
 * No engine can be made to do this on demand, and no engine is needed to: the
 * failure is entirely inside `followProgress`, which used to be wrapped in a
 * promise with no timeout of any kind. A registry that goes quiet mid-transfer
 * never ends the stream, so the completion callback never fires and the promise
 * never settles — and the caller is an installation, which is then blocked on a
 * line that cannot return, before any of its own deadlines have been armed. It
 * is the same hang as an unbounded `container.wait()`, one line earlier.
 *
 * Dockerode is driven through `client.api` here rather than mocked as a module:
 * what is under test is this class's handling of the three callbacks, and
 * substituting them is the smallest thing that isolates it.
 */
describe('a pull the registry stops answering', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stalling() {
    const client = makeClient();
    const state = { destroyed: false };

    let progress: ((event: { status?: string; progress?: string }) => void) | null = null;
    let finished: ((error: Error | null) => void) | null = null;

    const api = client.api as unknown as {
      listImages: () => Promise<unknown[]>;
      pull: () => Promise<unknown>;
      modem: {
        followProgress: (
          stream: unknown,
          onFinished: (error: Error | null) => void,
          onProgress: (event: { status?: string; progress?: string }) => void,
        ) => void;
      };
    };

    // Absent, so the pull is really attempted rather than short-circuited.
    api.listImages = () => Promise.resolve([]);
    api.pull = () =>
      Promise.resolve({
        destroy: () => {
          state.destroyed = true;
        },
      });
    api.modem.followProgress = (_stream, onFinished, onProgress) => {
      finished = onFinished;
      progress = onProgress;
    };

    return {
      client,
      state,
      layer: (): void => progress?.({ status: 'Downloading', progress: '[===>     ]' }),
      complete: (): void => finished?.(null),
    };
  }

  it('gives up rather than waiting for ever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const fake = stalling();
    const pulling = fake.client.pullImage('alpine:3.20');
    const settled = expect(pulling).rejects.toThrow(/stopped sending/);

    await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS + 1);
    await settled;

    // Destroyed, not merely abandoned: `followProgress` still holds the stream,
    // and the socket to the registry would otherwise stay open for the life of
    // the daemon.
    expect(fake.state.destroyed).toBe(true);
  });

  // The bound is on inactivity, like the installation's own. A pull receiving
  // layers is alive however large the image is, and a total-duration cap would
  // break precisely the images worth pulling.
  it('never gives up on a pull that is still receiving layers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const fake = stalling();
    const pulling = fake.client.pullImage('alpine:3.20');

    // Ten windows' worth of downloading, an event just inside each one.
    for (let layer = 0; layer < 10; layer += 1) {
      await vi.advanceTimersByTimeAsync(PULL_STALL_TIMEOUT_MS - 1_000);
      fake.layer();
    }

    fake.complete();

    await expect(pulling).resolves.toBeUndefined();
    expect(fake.state.destroyed).toBe(false);
  });
});

/**
 * The rule itself, read as a rule.
 *
 * `dockerRequestTimeout` is what decides how long any request gets, so its
 * default branch is the guarantee the whole design rests on: **an endpoint
 * nobody thought about is bounded**. The cases below are the exceptions, and
 * every one of them is an exception somebody had to write down.
 */
describe('how long a request to Docker gets', () => {
  const asked = (method: string, path: string, options?: Record<string, unknown>) =>
    dockerRequestTimeout({ method, path, ...(options ? { options } : {}) });

  /**
   * The one endpoint that answers when something happens rather than when asked.
   *
   * `POST /containers/{id}/wait` is how the daemon learns a container ended:
   * Docker holds it open until it does, which for an installation may be hours
   * and for a *server* is the whole time it is up. A bound on it would report
   * every long-running server as a crash.
   */
  it('never bounds the wait for a container to end', () => {
    expect(asked('POST', '/containers/hopper-3f2504e0/wait?')).toBeNull();
  });

  /**
   * Everything else, including endpoints this daemon does not call today. The
   * list is deliberately not a list: the function bounds by default and names
   * only what it excuses.
   */
  it.each([
    ['POST', '/containers/create?'],
    ['GET', '/containers/hopper-3f2504e0/json?'],
    ['POST', '/containers/hopper-3f2504e0/start?'],
    ['POST', '/containers/hopper-3f2504e0/kill?'],
    ['DELETE', '/containers/hopper-3f2504e0?'],
    ['GET', '/containers/hopper-3f2504e0/stats?'],
    ['GET', '/containers/hopper-3f2504e0/logs?'],
    ['POST', '/containers/hopper-3f2504e0/attach?'],
    ['GET', '/containers/json?'],
    ['GET', '/images/json?'],
    ['GET', '/networks?'],
    ['POST', '/networks/create?'],
    ['GET', '/_ping'],
    // Two nobody here calls yet, which is the point of asking.
    ['POST', '/containers/hopper-3f2504e0/exec'],
    ['POST', '/volumes/create'],
  ])('bounds %s %s', (method, path) => {
    expect(asked(method, path)).toBe(DOCKER_ANSWER_TIMEOUT_MS);
  });

  /**
   * A pull's own request, which is bounded on the registry's silence rather than
   * on this node's: Docker does not write the response headers until the
   * registry has answered the manifest behind them, and this file already
   * decided how long that may take.
   */
  it("gives a pull the registry's window rather than the node's", () => {
    expect(asked('POST', '/images/create?fromImage=alpine&tag=3.20')).toBe(PULL_STALL_TIMEOUT_MS);
  });

  /**
   * The grace a caller chose is added to the window rather than expected to fit
   * inside it. Docker sends SIGTERM, waits `t` seconds and only then answers, so
   * a five-minute stop bounded at one minute would report a Docker doing exactly
   * what it was told as one that had stopped answering.
   */
  it('adds the grace period a stop was told to wait', () => {
    expect(asked('POST', '/containers/hopper/stop?t=10', { t: 10 })).toBe(
      DOCKER_ANSWER_TIMEOUT_MS + 10_000,
    );
    expect(asked('POST', '/containers/hopper/restart?t=300', { t: 300 })).toBe(
      DOCKER_ANSWER_TIMEOUT_MS + 300_000,
    );
    // Docker's own default when the caller names none, added rather than assumed
    // to be covered.
    expect(asked('POST', '/containers/hopper/stop?')).toBe(DOCKER_ANSWER_TIMEOUT_MS + 10_000);
  });
});

/**
 * The rule against a Docker that accepts the connection and then says nothing.
 *
 * A real `DockerClient`, a real Dockerode, a real docker-modem and a real HTTP
 * request over a real socket — with a server on the far end that answers
 * nothing, or answers headers and then goes silent. No engine is needed and none
 * would help: no Docker can be asked to stop answering on demand, and what is
 * under test is what this client does when one has.
 *
 * The window is shortened by wrapping the client a second time. `boundEveryRequest`
 * wraps whatever `dial` it finds, so a second pass with a fifty-millisecond table
 * sits outside the production one and fires first; everything below the wrapper —
 * dockerode, the modem, the socket — is exactly what runs in production.
 */
describe('a Docker that has stopped answering', () => {
  /** Far shorter than the real window, and far longer than a local socket. */
  const WINDOW_MS = 50;

  let directory: string;
  let server: Server;
  let address: string;
  let accepted: Socket[] = [];

  /** What the server does with a connection, set by each test. */
  let respond: (socket: Socket) => void = () => undefined;

  beforeEach(async () => {
    // A named pipe on Windows and a Unix socket everywhere else — the same two
    // forms `docker.socket` itself accepts.
    directory = mkdtempSync(join(tmpdir(), 'hopper-docker-'));
    address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\hopper-test-${randomUUID()}`
        : join(directory, 'docker.sock');

    accepted = [];
    respond = () => undefined;

    server = createServer((socket) => {
      accepted.push(socket);
      // A connection that is never read from is one Node may close on its own;
      // this keeps it open and mute, which is the whole scenario.
      socket.on('data', () => respond(socket));
      socket.on('error', () => undefined);
    });

    await new Promise<void>((resolve) => server.listen(address, resolve));
  });

  afterEach(async () => {
    accepted.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  /** A client whose requests are bounded at {@link WINDOW_MS} rather than a minute. */
  function impatient(): DockerClient {
    const client = makeClient(address);

    boundEveryRequest(client.api, {
      timeoutFor: (request) =>
        // The exception list is the production one: only the window changes.
        dockerRequestTimeout(request) === null ? null : WINDOW_MS,
    });

    return client;
  }

  it('fails a question rather than waiting on it for ever', async () => {
    const client = impatient();

    await expect(client.api.getContainer('hopper-test').inspect()).rejects.toThrow(
      DockerUnansweredError,
    );
  });

  // The message is read by an operator on a console, and "Docker did not answer"
  // on its own leaves them nothing to look at. It names the request.
  it('names the request it gave up on', async () => {
    const client = impatient();

    await expect(client.api.getContainer('hopper-test').start()).rejects.toThrow(
      /POST \/containers\/hopper-test\/start/,
    );
  });

  /**
   * Abandoned *and* closed. Docker may answer this in a minute, and a socket
   * nobody is reading from would otherwise stay open for the life of the daemon
   * — on a node where every call is timing out, a file descriptor leak on top of
   * an outage.
   */
  it('closes the socket it gave up on', async () => {
    const client = impatient();

    await expect(client.api.getContainer('hopper-test').inspect()).rejects.toThrow(
      DockerUnansweredError,
    );

    await vi.waitFor(() => expect(accepted.some((socket) => socket.destroyed)).toBe(true));
  });

  /**
   * **The regression this whole mechanism had to avoid.**
   *
   * The daemon adopts running servers when it starts and streams their console
   * and their statistics. A quiet Minecraft server sends nothing down either for
   * hours by construction — a bound that reached the stream would take every
   * adopted server's console offline on a timer, which is far worse than the
   * hangs being fixed. So the deadline covers Docker answering and stops there:
   * the headers arrive, the promise settles, and what does or does not come down
   * the stream afterwards passes no deadline at all.
   */
  it('leaves a stream that has gone quiet alone', async () => {
    respond = (socket) => {
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
      );
    };

    const client = impatient();
    const stream = await client.api.getContainer('hopper-test').stats({ stream: true });

    let ended = false;
    stream.on('end', () => (ended = true));
    stream.on('error', () => (ended = true));

    // Twenty windows of a container saying nothing, which for a server that
    // nobody is playing on is a perfectly ordinary evening.
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 20));

    expect(ended).toBe(false);
    expect((stream as unknown as { destroyed?: boolean }).destroyed).not.toBe(true);
  });

  /**
   * And the same for the wait, which is left unbounded by name.
   *
   * `container.wait()` on a *server* container is how the daemon learns the
   * server exited. Bounding it would make every server that stays up longer than
   * the window look like a crash.
   */
  it('waits on a container ending for as long as it takes', async () => {
    const client = impatient();

    let settled = false;
    const waiting = client.api
      .getContainer('hopper-test')
      .wait()
      .then(
        () => (settled = true),
        () => (settled = true),
      );

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 20));

    expect(settled).toBe(false);

    // Released here rather than left for the runner to notice: the socket is
    // torn down in `afterEach`, and the rejection that follows has to have
    // somewhere to land.
    void waiting;
  });

  /**
   * Unbounded is not uncancellable, and the difference is a file descriptor.
   *
   * The wait being exempt from the rule is what makes it the one request nothing
   * in this daemon will ever close on its own — so a caller that walks away from
   * one, which the installer's teardown deadline does on every stalled install,
   * leaves a socket to the Docker daemon open for the life of the process. The
   * caller's own `abortSignal` is the way out of that, and it only works because
   * the wrapper hands the request through untouched on the unbounded path
   * instead of building a new one around its own controller.
   *
   * Proved against a real socket, like everything else in this block, because
   * the claim is about `docker-modem` and `http.request` rather than about a
   * flag: the signal has to survive dockerode lifting it out of the options,
   * the modem deleting it from the query string, and reach the request itself.
   */
  it('closes a wait its caller has given up on', async () => {
    const client = impatient();
    const abandon = new AbortController();

    const waiting = client.api.getContainer('hopper-test').wait({ abortSignal: abandon.signal });

    // The request is on the socket, and the far end is answering nothing.
    await vi.waitFor(() => expect(accepted.length).toBeGreaterThan(0));

    // Twenty windows of an unbounded request being ignored, which is the whole
    // point of exempting it.
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 20));

    abandon.abort();

    await expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(accepted.some((socket) => socket.destroyed)).toBe(true));
  });

  /**
   * The attach handshake, which is the one request in `client.ts` the rule
   * cannot reach: it is issued by hand rather than through dockerode, precisely
   * so that no byte of dockerode's own options can end up in a server's stdin.
   * It carries a bound of its own, and the console stream it hands back does
   * not.
   */
  it('gives up on an attach the socket never upgrades', async () => {
    const client = impatient();

    await expect(client.attachToContainer('hopper-test', WINDOW_MS)).rejects.toThrow(
      DockerUnansweredError,
    );
  });

  /**
   * **A Docker that is not answering must never become an accusation about the
   * network.**
   *
   * hopperd can be started before the engine is ready — systemd ordering is a
   * request, not a guarantee, and an engine restarts under a running daemon
   * often enough. The isolation verdict is re-taken on every `/api/system`, so
   * every one of those moments is a chance to report a perfectly good node as
   * having its servers wide open, which is worse than saying nothing: it sends
   * an operator to recreate a network that was never the problem, and it teaches
   * them to disbelieve the one report that will one day be true.
   *
   * So the answer is `unknown`, it says the engine did not answer, and it does
   * not throw — the caller is a route handler and a timer, neither of which has
   * anywhere to put an exception.
   */
  it('never accuses the network when Docker is the one not answering', async () => {
    const client = impatient();

    const verdict = await client.checkNetworkIsolation();

    expect(verdict.status).toBe('unknown');
    expect(verdict.network).toBe(NETWORK);
    expect(verdict.detail).toContain('did not answer');
  });
});

/**
 * Docker turning up after the deadline has already answered for it.
 *
 * The rule abandons a request that has run out of window, and abandoning it does
 * not stop it arriving: Docker may answer a minute later, and the abort issued
 * alongside the give-up surfaces on the same path as a request error. Either
 * way `docker-modem` calls back a second time, over a call this client has
 * already reported as unanswered.
 *
 * Nothing downstream notices, which is exactly why this is asked here. Every
 * caller in the daemon reaches these requests through dockerode's promise
 * wrapper, and a promise settles once and ignores the rest — so a second
 * callback carrying a real container inspection is invisible to all thirty-odd
 * tests around it while being a caller acting on data it was told did not
 * arrive. The guard is one line and its absence has no symptom, which is the
 * combination that gets a line deleted by someone tidying up.
 *
 * Driven against `dial` directly rather than through a socket, because what is
 * under test is the contract this wrapper offers its own caller — one callback,
 * whatever Docker does — and a real engine cannot be asked to answer late.
 */
describe('a Docker that answers after the deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The wrapper, over a `dial` that hands its callback to the test. */
  function wrapped(): {
    dial: (request: DockerRequest, callback: (error: unknown, result?: unknown) => void) => void;
    answerLate: (error: unknown, result?: unknown) => void;
  } {
    let late: ((error: unknown, result?: unknown) => void) | null = null;

    const docker = {
      modem: {
        dial: (_request: DockerRequest, callback: (error: unknown, result?: unknown) => void) => {
          late = callback;
        },
      },
    };

    boundEveryRequest(docker as unknown as Parameters<typeof boundEveryRequest>[0], {
      timeoutFor: () => 50,
    });

    return {
      dial: docker.modem.dial,
      answerLate: (error, result) => late?.(error, result),
    };
  }

  it('never calls a caller back a second time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const modem = wrapped();
    const answers: unknown[] = [];

    modem.dial({ method: 'GET', path: '/containers/hopper-test/json?' }, (error, result) =>
      answers.push(error ?? result),
    );

    await vi.advanceTimersByTimeAsync(51);

    expect(answers).toHaveLength(1);
    expect(answers[0]).toBeInstanceOf(DockerUnansweredError);

    // Docker gets round to it, with the answer nobody is waiting for any more.
    modem.answerLate(null, { State: { Running: true } });
    // And the abort issued with the give-up, arriving as a request error.
    modem.answerLate(new Error('The operation was aborted'));

    expect(answers).toHaveLength(1);
    expect(answers[0]).toBeInstanceOf(DockerUnansweredError);
  });

  // The mirror image, and the one that says the guard is a guard rather than a
  // switch: an answer that arrives inside the window is passed straight on, and
  // the deadline that was hanging over it never speaks.
  it('passes on an answer that arrived in time, and only that one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const modem = wrapped();
    const answers: unknown[] = [];

    modem.dial({ method: 'GET', path: '/containers/hopper-test/json?' }, (error, result) =>
      answers.push(error ?? result),
    );

    modem.answerLate(null, { State: { Running: true } });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(answers).toEqual([{ State: { Running: true } }]);
  });
});
