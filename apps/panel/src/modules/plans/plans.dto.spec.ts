import { describe, expect, it } from 'vitest';
import { createPlanSchema, planSlugSchema } from './plans.dto.js';

const TEMPLATE = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('the name a billing system quotes', () => {
  it.each(['minecraft-4gb', 'starter', 'pro-16gb-nvme', 'a1'])('accepts %s', (slug) => {
    expect(planSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each([
    ['a capital letter', 'Minecraft-4gb'],
    ['a space', 'minecraft 4gb'],
    ['an underscore', 'minecraft_4gb'],
    ['a leading dash', '-starter'],
    ['a trailing dash', 'starter-'],
    ['two dashes in a row', 'pro--16gb'],
    ['an accent', 'découverte'],
    ['one character', 'a'],
  ])('refuses %s', (_case, slug) => {
    expect(planSlugSchema.safeParse(slug).success).toBe(false);
  });

  it('says what shape it wants, since the reader is integrating', () => {
    const result = planSlugSchema.safeParse('Minecraft 4GB');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('minecraft-4gb');
  });
});

describe('what a plan needs to be created', () => {
  it('needs only a name, a template and the two limits that decide placement', () => {
    // Everything else has a default. An operator writing their first offer
    // should not have to hold an opinion on `ioWeight`.
    const result = createPlanSchema.safeParse({
      slug: 'starter',
      name: 'Starter',
      templateUuid: TEMPLATE,
      memoryBytes: 4 * 1024 ** 3,
      diskBytes: 20 * 1024 ** 3,
    });

    expect(result.success).toBe(true);
    expect(result.data?.pidsLimit).toBe(512);
    expect(result.data?.active).toBe(true);
    // Empty is "anywhere", so an instance with one node never names it.
    expect(result.data?.nodeUuids).toEqual([]);
    // Empty is the template's own default image.
    expect(result.data?.dockerImage).toBe('');
  });

  it('refuses limits the server would refuse later', () => {
    // The bounds match `createServerSchema` deliberately. A plan holding a
    // value a server rejects would fail in the middle of a purchase, after the
    // customer has paid.
    const overMemory = createPlanSchema.safeParse({
      slug: 'absurd',
      name: 'Absurd',
      templateUuid: TEMPLATE,
      memoryBytes: 2048 * 1024 ** 3,
      diskBytes: 20 * 1024 ** 3,
    });

    expect(overMemory.success).toBe(false);

    const tinyPids = createPlanSchema.safeParse({
      slug: 'tiny',
      name: 'Tiny',
      templateUuid: TEMPLATE,
      memoryBytes: 1024 ** 3,
      diskBytes: 1024 ** 3,
      pidsLimit: 8,
    });

    expect(tinyPids.success).toBe(false);
  });

  it('accepts zero for memory and disk, which means unlimited as it does on a server', () => {
    const result = createPlanSchema.safeParse({
      slug: 'unlimited',
      name: 'Unlimited',
      templateUuid: TEMPLATE,
      memoryBytes: 0,
      diskBytes: 0,
    });

    expect(result.success).toBe(true);
  });
});
