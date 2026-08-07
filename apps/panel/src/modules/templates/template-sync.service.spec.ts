import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { templateDefinitionSchema, type TemplateDefinition } from '@hopper/templates';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TemplateSyncService } from './template-sync.service.js';

/**
 * How a template definition becomes a row.
 *
 * The interesting half is the readiness strategy: it is the only field the
 * catalogue can use to say something other than "watch the console", and a
 * field that fails to make the crossing does not fail loudly — it produces a
 * server that waits for a line nobody will print.
 */

const definition = (fields: Partial<TemplateDefinition> = {}): TemplateDefinition =>
  templateDefinitionSchema.parse({
    key: 'test-template',
    group: 'Tests',
    name: 'Test',
    dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
    startup: 'java -jar server.jar',
    installScript: 'set -e',
    ...fields,
  });

/**
 * The slice of Prisma the synchronisation touches, recording what it is asked
 * to write. `$transaction` takes an array whose entries Prisma builds eagerly,
 * so the update has already recorded its payload by the time it is awaited.
 */
class RecordingPrisma {
  readonly written: Record<string, unknown>[] = [];
  existing: { id: number; modifiedByAdmin: boolean } | null = null;

  readonly templateGroup = {
    upsert: () => Promise.resolve({ id: 1 }),
  };

  readonly template = {
    findFirst: () => Promise.resolve(this.existing),
    create: ({ data }: { data: Record<string, unknown> }) => {
      this.written.push(data);
      return Promise.resolve(data);
    },
    update: ({ data }: { data: Record<string, unknown> }) => {
      this.written.push(data);
      return data;
    },
  };

  readonly templateVariable = {
    deleteMany: () => ({}),
    createMany: () => ({}),
  };

  $transaction = (operations: unknown[]) => Promise.resolve(operations);

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }
}

describe('TemplateSyncService.upsert', () => {
  it('writes the strategy a new template declares', async () => {
    const prisma = new RecordingPrisma();

    await new TemplateSyncService(prisma.asService()).upsert(
      // `timeoutMs` is spelled out because a template that wants a start
      // capable of failing has to say so: the schema fills in no deadline of
      // its own. What matters here is only that whatever was declared reaches
      // the column unaltered.
      definition({
        readiness: { type: 'log', patterns: ['Done \\(', 'Server started'], timeoutMs: 600_000 },
      }),
    );

    expect(prisma.written[0]).toMatchObject({
      readiness: { type: 'log', patterns: ['Done \\(', 'Server started'] },
    });
  });

  it('writes it again when an existing template is updated', async () => {
    // The update path is a separate object literal from the create path in
    // Prisma's eyes, but the same one here — this test is what keeps it so.
    const prisma = new RecordingPrisma();
    prisma.existing = { id: 7, modifiedByAdmin: false };

    await new TemplateSyncService(prisma.asService()).upsert(
      definition({ readiness: { type: 'immediate' } }),
    );

    expect(prisma.written[0]).toMatchObject({ readiness: { type: 'immediate' } });
  });

  it('writes an explicit SQL NULL when the definition declares nothing', async () => {
    // `undefined` means "leave the column alone" to Prisma. A template that
    // dropped its strategy would then keep the previous one for ever, with
    // nothing in the catalogue saying where it came from. `Prisma.DbNull` and
    // not `null`: Prisma refuses a bare null on a nullable Json column, and
    // this test is what stops the obvious fix from being written back.
    const prisma = new RecordingPrisma();
    prisma.existing = { id: 7, modifiedByAdmin: false };

    await new TemplateSyncService(prisma.asService()).upsert(definition());

    expect(prisma.written[0]).toHaveProperty('readiness', Prisma.DbNull);
  });

  it('keeps carrying the deprecated console pattern', async () => {
    // Every shipped template still declares only this. Both fields travel: the
    // daemon prefers the strategy and falls back to the pattern.
    const prisma = new RecordingPrisma();

    await new TemplateSyncService(prisma.asService()).upsert(
      definition({ startupDetection: '\\)! For help, type "help"' }),
    );

    expect(prisma.written[0]).toMatchObject({
      startupDetection: '\\)! For help, type "help"',
      readiness: Prisma.DbNull,
    });
  });

  it('writes the structured stop and the stop timeout', async () => {
    // The two fields that decide whether a server ever shuts down cleanly. A
    // stop that fails to make the crossing does not fail loudly either: the
    // daemon goes on signalling a process that ignores signals, then kills it.
    const prisma = new RecordingPrisma();

    await new TemplateSyncService(prisma.asService()).upsert(
      definition({
        stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
        stopTimeoutSeconds: 240,
      }),
    );

    expect(prisma.written[0]).toMatchObject({
      stop: { type: 'rcon', command: 'quit', role: 'rcon', secretVariable: 'RCON_PASSWORD' },
      stopTimeoutSeconds: 240,
      // And the string is still written beside it: it is what a node running an
      // older daemon reads, and the only thing it can read.
      stopCommand: 'command:stop',
    });
  });

  it('forgets a structured stop a definition has dropped', async () => {
    // `undefined` means "leave the column alone" to Prisma, so without this the
    // row would keep stopping over a transport the template has removed — over
    // RCON to a port it no longer names, which by design refuses the stop
    // outright rather than falling back.
    const prisma = new RecordingPrisma();
    prisma.existing = { id: 7, modifiedByAdmin: false };

    await new TemplateSyncService(prisma.asService()).upsert(definition());

    expect(prisma.written[0]).toHaveProperty('stop', Prisma.DbNull);
    // A plain nullable column, so a plain null: "this template names no
    // timeout", which the panel turns into the contract's default.
    expect(prisma.written[0]).toHaveProperty('stopTimeoutSeconds', null);
  });

  it('writes the two install guards', async () => {
    // Neither is a figure the panel can supply on a template's behalf: the
    // inactivity window belongs to the workload, and the disk requirement is
    // something only whoever wrote the download knows.
    const prisma = new RecordingPrisma();

    await new TemplateSyncService(prisma.asService()).upsert(
      definition({ installInactivityTimeoutMs: 900_000, installRequiredDiskBytes: 40 * 1024 ** 3 }),
    );

    expect(prisma.written[0]).toMatchObject({
      installInactivityTimeoutMs: 900_000,
      installRequiredDiskBytes: 42_949_672_960,
    });
  });

  it('forgets install guards a definition has dropped', async () => {
    // `undefined` means "leave the column alone" to Prisma, so without the
    // explicit null a template whose author decided its install is allowed to
    // take longer would go on being stopped by the window they removed.
    const prisma = new RecordingPrisma();
    prisma.existing = { id: 7, modifiedByAdmin: false };

    await new TemplateSyncService(prisma.asService()).upsert(definition());

    expect(prisma.written[0]).toHaveProperty('installInactivityTimeoutMs', null);
    expect(prisma.written[0]).toHaveProperty('installRequiredDiskBytes', null);
  });

  it('leaves an administrator-edited template untouched', async () => {
    const prisma = new RecordingPrisma();
    prisma.existing = { id: 7, modifiedByAdmin: true };

    const result = await new TemplateSyncService(prisma.asService()).upsert(
      definition({ readiness: { type: 'immediate' } }),
    );

    expect(result).toBe('skipped');
    expect(prisma.written).toEqual([]);
  });
});

/**
 * The seed maps a definition to a row a second time, on purpose: it runs
 * outside NestJS's injection container and cannot reuse the service. Nothing
 * but agreement between the two copies makes them equivalent, and a field
 * added to one alone is invisible — the seeded instance simply behaves unlike
 * the synchronised one, months later, on one machine.
 */
describe('the seed copy of the mapping', () => {
  it('writes the readiness strategy too', () => {
    const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');
    const mapping = /const data = \{(.*?)\n {4}\};/s.exec(seed);

    expect(mapping, 'the template mapping was not found in prisma/seed.ts').not.toBeNull();
    expect(mapping?.[1]).toMatch(/^\s*readiness:/m);
    // And the field it falls back to is still there next to it.
    expect(mapping?.[1]).toMatch(/^\s*startupDetection:/m);
  });

  it('writes the stop transport and its timeout too', () => {
    // The same duplication, one release later, and a quieter symptom: a seeded
    // instance and a resynchronised one would hold the same template in two
    // different states, and a stop transport is only exercised the first time
    // somebody presses Stop.
    const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');
    const mapping = /const data = \{(.*?)\n {4}\};/s.exec(seed);

    expect(mapping?.[1]).toMatch(/^\s*stop:/m);
    expect(mapping?.[1]).toMatch(/^\s*stopTimeoutSeconds:/m);
    // The string the structured field falls back to, still beside it.
    expect(mapping?.[1]).toMatch(/^\s*stopCommand:/m);
  });

  it('writes the two install guards too', () => {
    // Quieter again than the stop transport, which at least fails the first
    // time somebody presses Stop. A seeded instance missing these installs with
    // the daemon's default window and no declared disk requirement, and the
    // difference only shows the day an install stalls or fills a node.
    const seed = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');
    const mapping = /const data = \{(.*?)\n {4}\};/s.exec(seed);

    expect(mapping?.[1]).toMatch(/^\s*installInactivityTimeoutMs:/m);
    expect(mapping?.[1]).toMatch(/^\s*installRequiredDiskBytes:/m);
  });
});
