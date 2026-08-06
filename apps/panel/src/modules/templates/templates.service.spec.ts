import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TemplatesService } from './templates.service.js';

/**
 * What the interface is allowed to see of a template.
 *
 * The readiness strategy is there for one reason: a server stuck in `starting`
 * is waiting for something, and until this was exposed the only way to find
 * out what was to read a JSON column by hand.
 */

const templateRow = (readiness: unknown) => ({
  uuid: '6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11',
  name: 'Paper',
  description: '',
  author: 'Hopper',
  startup: 'java -jar server.jar',
  dockerImages: [{ name: 'Java 21', image: 'eclipse-temurin:21-jre-noble' }],
  readiness,
  group: { uuid: 'c4b6a5c8-2a1e-4c8f-9a52-2c2b0d5f7e10', name: 'Minecraft: Java Edition' },
  variables: [],
});

const serviceFor = (readiness: unknown) =>
  new TemplatesService({
    template: { findUnique: () => Promise.resolve(templateRow(readiness)) },
  } as unknown as PrismaService);

describe('TemplatesService template view', () => {
  it('shows the strategy the template declares', async () => {
    const view = await serviceFor({ type: 'port', protocol: 'tcp', delayMs: 5000 }).findByUuid(
      '6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11',
    );

    // Including the protocol and delay the schema fills in: the view shows
    // what the daemon will actually be handed, not only what the row happens
    // to hold. No deadline appears among them — a template that named none is
    // shown as having named none, because that is the difference between a
    // start that can fail and one that cannot.
    expect(view.readiness).toEqual({
      type: 'port',
      protocol: 'tcp',
      delayMs: 5000,
    });
  });

  it('shows null for a template that declares nothing', async () => {
    // The whole shipped catalogue. Null here means "watched by the console
    // pattern", which is the panel's oldest behaviour and still the common one.
    const view = await serviceFor(null).findByUuid('6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11');

    expect(view.readiness).toBeNull();
  });

  it('shows null rather than a shape no client can read', async () => {
    // The column is free-form JSON, so a value that matches no strategy is
    // possible. Handing it to the interface as it stands would only move the
    // problem into a browser. The loud report belongs to the path that builds
    // the daemon's configuration, where an unreadable strategy changes what
    // the server actually does.
    const view = await serviceFor({ type: 'query', game: 'source' }).findByUuid(
      '6f1c2f4a-8f43-4d31-9d1b-9e2b7c2f0f11',
    );

    expect(view.readiness).toBeNull();
  });
});
