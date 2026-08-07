import { describe, expect, it } from 'vitest';
import { NODE_CAPABILITIES, systemInformationSchema } from './daemon-api.js';

/**
 * What a node says it can do.
 *
 * The panel and its nodes are not upgraded together — that is the whole reason
 * this contract exists — and until now the only thing it could ask a daemon
 * was its version, which says nothing about what was backported into it. The
 * alternative to capabilities was bumping `CONTRACT_VERSION`, and that is not
 * a version check: the panel marks a node announcing a different one
 * unreachable outright, so a bump takes every server on every node offline
 * until the last daemon has been upgraded.
 */

const MINIMAL = {
  version: '0.3.1',
  kernelVersion: '6.8.0',
  architecture: 'x64',
  os: 'linux',
  cpuCount: 8,
  memoryTotalBytes: 34_359_738_368,
  docker: {
    version: '27.0.3',
    storageDriver: 'overlay2',
    cgroupVersion: '2',
    runningContainers: 3,
  },
};

describe('systemInformationSchema', () => {
  it('reads a daemon that predates capabilities as announcing none', () => {
    // Which is the truth about it, and the answer the panel has to act on: it
    // strips a `role` it has never heard of without a word, so the panel
    // refuses to store one for its servers.
    expect(systemInformationSchema.parse(MINIMAL).capabilities).toEqual([]);
  });

  it('carries the capabilities a daemon announces', () => {
    const parsed = systemInformationSchema.parse({
      ...MINIMAL,
      capabilities: [NODE_CAPABILITIES.allocationRoles],
    });

    expect(parsed.capabilities).toContain('allocation-roles');
  });

  it('accepts a capability this panel has never heard of', () => {
    // This panel is the old panel of every release after it. A daemon
    // announcing something newer must parse — an unreadable answer is reported
    // as "its version is probably too old", which would be exactly backwards
    // and would take the node offline for being ahead.
    const parsed = systemInformationSchema.safeParse({
      ...MINIMAL,
      capabilities: ['allocation-roles', 'something-added-later'],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.capabilities).toHaveLength(2);
  });
});
