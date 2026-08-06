import type { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ServerConfigurationService, parseReadiness } from './server-configuration.service.js';

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
 * A server row complete enough to be translated. Only the fields the
 * translation reads are here; the rest would be noise.
 */
function serverRow(template: Record<string, unknown>) {
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
    primaryAllocation: { id: 1, ip: '0.0.0.0', port: 25565 },
    allocations: [{ id: 1, ip: '0.0.0.0', port: 25565 }],
    variables: [],
    template: {
      stopCommand: 'command:stop',
      startupDetection: null,
      readiness: null,
      configFiles: [],
      fileDenylist: [],
      installContainer: 'debian:bookworm-slim',
      installEntrypoint: '/bin/bash',
      installScript: 'set -e',
      ...template,
    },
  };
}

const serviceFor = (template: Record<string, unknown>) =>
  new ServerConfigurationService({
    server: { findUniqueOrThrow: () => Promise.resolve(serverRow(template)) },
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
