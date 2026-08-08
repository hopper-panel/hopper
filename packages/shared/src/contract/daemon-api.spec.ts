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

  /**
   * The network verdict is optional for the same reason capabilities default to
   * empty: the panel meets daemons older than itself, and "said nothing" has to
   * parse. What it must never become is "said it was open".
   */
  it('reads a daemon that predates the isolation check as reporting nothing', () => {
    expect(systemInformationSchema.parse(MINIMAL).networkIsolation).toBeUndefined();
  });

  it('carries the isolation verdict a daemon reports', () => {
    const parsed = systemInformationSchema.parse({
      ...MINIMAL,
      networkIsolation: {
        network: 'hopper0',
        status: 'open',
        detail: 'com.docker.network.bridge.enable_icc is not set on it',
      },
    });

    expect(parsed.networkIsolation?.status).toBe('open');
  });

  /**
   * A daemon newer than this panel, answering a word this panel has never heard
   * of. Read strictly it would fail the whole payload, and an unreadable payload
   * is reported as "its version is probably too old" — the node would be taken
   * offline for being ahead, over a diagnostic field.
   */
  it('degrades an isolation status it cannot read to "unknown"', () => {
    const parsed = systemInformationSchema.safeParse({
      ...MINIMAL,
      networkIsolation: { network: 'hopper0', status: 'quarantined', detail: 'something newer' },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.networkIsolation?.status).toBe('unknown');
    // The sentence survives even when the word does not: it is what an operator
    // is shown, and a daemon that knows more about its own state than this panel
    // does is still worth quoting.
    expect(parsed.data?.networkIsolation?.detail).toBe('something newer');
  });

  it('never fails a payload over an isolation report of the wrong shape', () => {
    const parsed = systemInformationSchema.safeParse({ ...MINIMAL, networkIsolation: 'nope' });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.networkIsolation).toBeUndefined();
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
