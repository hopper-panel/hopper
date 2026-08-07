import type { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  ServerConfigurationService,
  installGuards,
  parseReadiness,
  parseStop,
  parseStopCommand,
} from './server-configuration.service.js';

/**
 * What the panel tells the daemon about readiness.
 *
 * The column holding it is free-form JSON — no column can hold a discriminated
 * union — so the panel is the last place able to say "this is not a strategy"
 * while there is still a human to say it to. Past that point the daemon takes
 * silence for consent and calls a container that is up a server that is ready.
 */

const collectingLogger = () => {
  const errors: string[] = [];
  const warnings: string[] = [];

  return {
    errors,
    warnings,
    logger: {
      error: (message: string) => errors.push(message),
      warn: (message: string) => warnings.push(message),
    } as unknown as Logger,
  };
};

describe('parseReadiness', () => {
  it('reads a strategy back exactly as it was stored', () => {
    const { logger, errors } = collectingLogger();

    const readiness = parseReadiness(
      { type: 'log', patterns: ['Done \\(', 'Server started'] },
      'server-uuid',
      logger,
    );

    // Exactly as it was stored, `timeoutMs` included — which is to say absent.
    // A deadline is what makes a start capable of failing, and a row written
    // before deadlines existed must not acquire one on its way to the daemon:
    // that would stop servers whose templates never asked to be given up on.
    expect(readiness).toEqual({
      type: 'log',
      patterns: ['Done \\(', 'Server started'],
    });
    expect(errors).toEqual([]);
  });

  it('fills in the defaults the schema declares', () => {
    // The stored row carries what the template said; the protocol and the
    // delay are the contract's business, and the daemon must not have to guess
    // them from an absent key. The deadline is not among them — see above.
    const { logger } = collectingLogger();

    expect(parseReadiness({ type: 'port' }, 'server-uuid', logger)).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 0,
    });
  });

  it('emits undefined, not null, when the template declares nothing', () => {
    // `null` is a value in JSON and `serverConfigurationSchema` would refuse
    // it. The absent case is the ordinary one — the whole bundled catalogue —
    // so it has to be the one that cannot fail.
    const { logger, errors } = collectingLogger();

    expect(parseReadiness(null, 'server-uuid', logger)).toBeUndefined();
    expect(parseReadiness(undefined, 'server-uuid', logger)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('drops a stored value that is not a strategy, and says so', () => {
    // Somebody hand-edited the row, or restored a dump written by a Hopper
    // that spelled it differently. Either way the server will now be watched
    // by whatever `startupDetection` says, or by nothing at all — and this log
    // line is the only difference between that and a mystery.
    const { logger, errors } = collectingLogger();

    expect(
      parseReadiness({ type: 'query', game: 'source' }, 'server-uuid', logger),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('server-uuid');
  });

  it('drops a strategy whose own fields are wrong', () => {
    // The discriminator alone is not enough: a `log` with no pattern is an
    // empty promise, and one that reached the daemon would be resolved as
    // "call it running now" by a component with nothing left to check.
    const { logger, errors } = collectingLogger();

    expect(parseReadiness({ type: 'log', patterns: [] }, 'server-uuid', logger)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('drops anything that is not an object at all', () => {
    const { logger, errors } = collectingLogger();

    expect(parseReadiness('immediate', 'server-uuid', logger)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

/**
 * How the panel decides what a stop is.
 *
 * Two shapes, and the interesting thing about them is that they fail in
 * opposite directions on purpose. The colon-encoded string falls back to
 * SIGTERM, which is defensible for what it was written for — a Bukkit server
 * takes SIGTERM well, and a less graceful stop beat a server nobody could
 * launch. The structured column refuses, because a template only fills it in
 * when the string could not express its stop, and the reason it could not is
 * almost always a game whose save is written on shutdown and nowhere else.
 */
describe('parseStop', () => {
  const UUID = 'server-uuid';

  it('reads the string when no structured stop is stored', () => {
    // Every server in existence takes this path: the whole bundled catalogue
    // and every imported egg carry the string and nothing else.
    expect(parseStop(null, 'command:stop', UUID)).toEqual({ type: 'command', value: 'stop' });
    expect(parseStop(undefined, 'signal:SIGINT', UUID)).toEqual({
      type: 'signal',
      value: 'SIGINT',
    });
  });

  it('prefers the structured stop when the template declares one', () => {
    const stop = {
      type: 'rcon',
      command: 'quit',
      role: 'rcon',
      secretVariable: 'RCON_PASSWORD',
    };

    // And the string is ignored rather than merged: they are two ways of saying
    // the same thing, and a template that filled in the column meant it.
    expect(parseStop(stop, 'command:stop', UUID)).toEqual(stop);
  });

  it('refuses an unreadable structured stop instead of falling back', () => {
    // The single most dangerous silent default this could have inherited. A
    // template that declared an RCON stop and then could not be read would be
    // handed the signal-then-SIGKILL it was written to avoid, on every stop,
    // through whatever the game writes on exit.
    expect(() => parseStop({ type: 'rcon', command: 'quit' }, 'command:stop', UUID)).toThrow(
      /cannot be read/,
    );
    expect(() => parseStop({ type: 'telnet' }, 'command:stop', UUID)).toThrow(UUID);
  });

  it('names the way out in the refusal', () => {
    // A refusal an operator cannot act on is an outage with an explanation.
    // Clearing the column is the escape hatch, and it has to be in the message.
    expect(() => parseStop({ type: 'telnet' }, 'command:stop', UUID)).toThrow(/clear the field/);
  });
});

describe('parseStopCommand', () => {
  it('still falls back to SIGTERM, exactly as it always has', () => {
    // Left alone deliberately. Every server that starts today goes through
    // here, and tightening it would turn servers that start into servers that
    // refuse to, over a value nobody has looked at in months.
    expect(parseStopCommand('who knows')).toEqual({ type: 'signal', value: 'SIGTERM' });
    expect(parseStopCommand('signal:SIGUSR1')).toEqual({ type: 'signal', value: 'SIGTERM' });
    expect(parseStopCommand('command:/quit')).toEqual({ type: 'command', value: '/quit' });
  });
});

/**
 * A server row complete enough to be translated. Only the fields the
 * translation reads are here; the rest would be noise.
 */
function serverRow(template: Record<string, unknown>, allocations?: Record<string, unknown>[]) {
  return {
    uuid: '1b32d12d-7b10-443e-a259-6a31d67e28e6',
    name: 'Test',
    description: '',
    status: 'READY',
    startupCommand: 'java -jar server.jar',
    memoryBytes: BigInt(1024),
    swapBytes: BigInt(0),
    diskBytes: BigInt(2048),
    cpuPercent: 100,
    cpuSet: '',
    ioWeight: 500,
    pidsLimit: 512,
    oomKillDisabled: false,
    dockerImage: 'eclipse-temurin:21-jre-noble',
    requiresRebuild: false,
    primaryAllocationId: 1,
    primaryAllocation: { id: 1, ip: '0.0.0.0', port: 25565, role: null },
    allocations: allocations ?? [{ id: 1, ip: '0.0.0.0', port: 25565, role: null }],
    variables: [],
    template: {
      stopCommand: 'command:stop',
      stop: null,
      stopTimeoutSeconds: null,
      startupDetection: null,
      readiness: null,
      configFiles: [],
      fileDenylist: [],
      installContainer: 'debian:bookworm-slim',
      installEntrypoint: '/bin/bash',
      installScript: 'set -e',
      installInactivityTimeoutMs: null,
      installRequiredDiskBytes: null,
      ...template,
    },
  };
}

const serviceFor = (template: Record<string, unknown>, allocations?: Record<string, unknown>[]) =>
  new ServerConfigurationService({
    server: { findUniqueOrThrow: () => Promise.resolve(serverRow(template, allocations)) },
  } as unknown as PrismaService);

describe('ServerConfigurationService.build', () => {
  it('sends the strategy the template declares', async () => {
    const configuration = await serviceFor({
      readiness: { type: 'port', protocol: 'tcp', delayMs: 5000 },
    }).build('1b32d12d-7b10-443e-a259-6a31d67e28e6');

    expect(configuration.readiness).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 5000,
    });
  });

  it('keeps sending startupDetection next to it', async () => {
    // A node still running an older daemon reads nothing else. Sending only
    // the new field would silently stop that node recognising a server it was
    // watching correctly a minute earlier.
    const configuration = await serviceFor({
      startupDetection: '\\)! For help, type "help"',
      readiness: { type: 'immediate' },
    }).build('1b32d12d-7b10-443e-a259-6a31d67e28e6');

    expect(configuration.startupDetection).toBe('\\)! For help, type "help"');
    expect(configuration.readiness).toEqual({ type: 'immediate' });
  });

  it('leaves a template from before the column exactly as it was', async () => {
    const configuration = await serviceFor({
      startupDetection: '\\)! For help, type "help"',
    }).build('1b32d12d-7b10-443e-a259-6a31d67e28e6');

    expect(configuration.startupDetection).toBe('\\)! For help, type "help"');
    expect(configuration.readiness).toBeUndefined();
  });

  it('still builds a configuration when the stored strategy is unreadable', async () => {
    // The alternative is throwing, which `buildForNode` would turn into a
    // server the daemon is never told about: it would stop, and nothing would
    // start it again. A server that starts and is watched by the old field
    // beats one that has disappeared.
    const configuration = await serviceFor({
      startupDetection: '\\)! For help, type "help"',
      readiness: { type: 'nonsense' },
    }).build('1b32d12d-7b10-443e-a259-6a31d67e28e6');

    expect(configuration.readiness).toBeUndefined();
    expect(configuration.startupDetection).toBe('\\)! For help, type "help"');
  });
});

/**
 * What the daemon is told about stopping the server.
 *
 * The failure this guards is the quiet one: a template declares that its game
 * only shuts down cleanly over RCON, the field does not make the crossing, and
 * the daemon goes on signalling a process that ignores signals — then kills it.
 * Nothing about that looks like a bug until somebody loads a world that is
 * hours old.
 */
describe('ServerConfigurationService.build stop', () => {
  const UUID = '1b32d12d-7b10-443e-a259-6a31d67e28e6';

  it('sends the structured stop a template declares', async () => {
    const stop = { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' };

    expect((await serviceFor({ stop }).build(UUID)).stop).toEqual(stop);
  });

  it('decodes the string for every template that declares no structured stop', async () => {
    // The whole shipped catalogue, unchanged.
    const configuration = await serviceFor({ stopCommand: 'command:/quit' }).build(UUID);

    expect(configuration.stop).toEqual({ type: 'command', value: '/quit' });
  });

  it('leaves a template with no stop timeout on the contract default', async () => {
    // Thirty seconds: what every server on every installation has run on since
    // the first release, because until now no template could name anything.
    expect((await serviceFor({}).build(UUID)).stopTimeoutSeconds).toBe(30);
  });

  it('takes the stop timeout the template declares', async () => {
    // The gap this closes: a large world SIGKILLed mid-save loses everything
    // since the last autosave, and that is exactly the failure an RCON-stopped
    // game is most exposed to.
    expect((await serviceFor({ stopTimeoutSeconds: 240 }).build(UUID)).stopTimeoutSeconds).toBe(
      240,
    );
  });

  it('refuses to describe a server whose stored stop is unreadable', async () => {
    // Rather than describing it wrongly. `buildForNode` logs this and skips the
    // server; the daemon reports a server it has that the panel did not
    // describe and never deletes one, so nothing is destroyed by the refusal.
    await expect(serviceFor({ stop: { type: 'rcon' } }).build(UUID)).rejects.toThrow(/stop/);
  });
});

/**
 * What the daemon is told about surviving the installation itself.
 *
 * Both guards are new columns, and the case that has to be exactly right is the
 * one every existing template is in: declaring neither, and producing the
 * payload it has always produced.
 */
describe('ServerConfigurationService.build install', () => {
  const UUID = '1b32d12d-7b10-443e-a259-6a31d67e28e6';

  it('sends the install object unchanged for a template that declares neither guard', async () => {
    const configuration = await serviceFor({}).build(UUID);

    // The keys are asserted rather than the value, because neither `toEqual`
    // nor `JSON.stringify` can tell an absent key from one holding `undefined`
    // — and "absent" is what the whole existing catalogue has to keep sending.
    expect(Object.keys(configuration.install!)).toEqual(['containerImage', 'entrypoint', 'script']);
  });

  it('carries the inactivity window a template names', async () => {
    const configuration = await serviceFor({ installInactivityTimeoutMs: 900_000 }).build(UUID);

    expect(configuration.install?.inactivityTimeoutMs).toBe(900_000);
  });

  it('carries a declared download size across the BigInt column', async () => {
    // Forty gigabytes is past what an INTEGER column holds, which is why the
    // column is a BigInt — and past what a JSON payload can carry as one, which
    // is why it is converted here.
    const configuration = await serviceFor({
      installRequiredDiskBytes: BigInt(40) * BigInt(1024) ** BigInt(3),
    }).build(UUID);

    expect(configuration.install?.requiredDiskBytes).toBe(42_949_672_960);
  });
});

/**
 * The keys are asserted, never the value.
 *
 * `toEqual({})` passes on `{ inactivityTimeoutMs: undefined }`, which is the one
 * shape this function exists to avoid producing — so a version of it written
 * with `inactivityTimeoutMs: template.installInactivityTimeoutMs ?? undefined`,
 * emitting both keys always, would leave a `toEqual({})` test green while
 * sending every existing template a payload it has never sent. `Object.keys` is
 * what tells those apart, as it does for the allocation roles below.
 */
describe('installGuards', () => {
  it('says nothing at all when the template declares nothing', () => {
    expect(
      Object.keys(
        installGuards({ installInactivityTimeoutMs: null, installRequiredDiskBytes: null }),
      ),
    ).toEqual([]);
  });

  // A row read back without the columns — an older dump, a `select` written
  // before they existed — must behave like a template that declared nothing,
  // not emit a key holding `undefined`.
  it('says nothing for columns that are not there at all', () => {
    expect(Object.keys(installGuards({} as never))).toEqual([]);
  });

  // And the other half of the same rule: a template that *does* declare one
  // guard sends that key and only that key.
  it('sends only the guard the template named', () => {
    const guards = installGuards({
      installInactivityTimeoutMs: 900_000,
      installRequiredDiskBytes: null,
    });

    expect(Object.keys(guards)).toEqual(['inactivityTimeoutMs']);
    expect(guards.inactivityTimeoutMs).toBe(900_000);
  });
});

/**
 * The names the daemon matches a readiness `role` against.
 *
 * The rule that matters here is the one nobody sees when it holds: a server
 * with no named port must produce the payload it has always produced. Every
 * Minecraft server on every existing installation is that server.
 */
describe('ServerConfigurationService.build allocation names', () => {
  const UUID = '1b32d12d-7b10-443e-a259-6a31d67e28e6';

  it('sends nothing at all for a port with no name', async () => {
    // The key must be **absent**, not present holding `undefined`, and neither
    // `toEqual` nor `JSON.stringify` can tell those apart — `toEqual` treats an
    // undefined-valued key as missing, and `JSON.stringify` drops it. An
    // earlier version of this test compared JSON believing it caught the case;
    // replacing the conditional spread with `role: allocation.role ?? undefined`
    // left it green.
    //
    // So the presence of the key is asserted directly. It matters because
    // anything comparing configurations to decide what to resync sees a
    // different object, and because a server with no named port has to send the
    // payload it has always sent.
    const configuration = await serviceFor({}, [
      { id: 1, ip: '0.0.0.0', port: 25565, role: null },
      { id: 2, ip: '0.0.0.0', port: 8123, role: null },
    ]).build(UUID);

    const [additional] = configuration.allocations.additional;

    expect(Object.hasOwn(additional!, 'role')).toBe(false);
    expect(Object.keys(additional!)).toEqual(['ip', 'port']);
    expect(Object.hasOwn(configuration.allocations.default, 'role')).toBe(false);
    expect(configuration.allocations).toEqual({
      default: { ip: '0.0.0.0', port: 25565 },
      additional: [{ ip: '0.0.0.0', port: 8123 }],
    });
  });

  it('carries the name of a port that has one', async () => {
    const configuration = await serviceFor({}, [
      { id: 1, ip: '0.0.0.0', port: 25565, role: null },
      { id: 2, ip: '0.0.0.0', port: 25575, role: 'rcon' },
    ]).build(UUID);

    expect(configuration.allocations.additional).toEqual([
      { ip: '0.0.0.0', port: 25575, role: 'rcon' },
    ]);
  });

  it('gives the primary port no name even if the row carries one', async () => {
    // The contract leaves `allocations.default` no field to hold one, so this
    // is what the schema does rather than what the panel chooses — but a row
    // in that state can only come from a hand-edited database, and it must
    // produce a configuration the daemon accepts rather than one it rejects.
    const configuration = await serviceFor({}, [
      { id: 1, ip: '0.0.0.0', port: 25565, role: 'game' },
    ]).build(UUID);

    expect(configuration.allocations.default).toEqual({ ip: '0.0.0.0', port: 25565 });
    expect(configuration.allocations.additional).toEqual([]);
  });
});
