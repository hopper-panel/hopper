import { describe, expect, it } from 'vitest';
import { AUDIT_EVENTS } from '../audit/audit.service.js';
import { describeEvent } from './describe-event.js';

describe('describeEvent', () => {
  it('renders a sentence for a power action', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'restart' })).toBe(
      'Restarted the server.',
    );
  });

  /**
   * The Activity tab is where an operator goes after a scheduled stop to find
   * out whether it ran. Reading only `action` renders a refusal as the thing
   * that did not happen — "Stopped the server." over a server still serving
   * players — and ends the investigation there.
   */
  it('says a power action was refused rather than reporting it as done', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'stop', refused: true })).toContain(
      'Refused',
    );
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'stop', refused: true }),
    ).not.toContain('Stopped the server.');
  });

  it('still reports an ordinary stop as a stop', () => {
    // The flag is absent on every power record written before it existed, and
    // on every one that succeeded.
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'stop' })).toBe(
      'Stopped the server.',
    );
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'stop', refused: false })).toBe(
      'Stopped the server.',
    );
  });

  it('quotes the command that was run', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_COMMAND, { command: 'say hello' })).toContain(
      'say hello',
    );
  });

  /**
   * `server.updated` is the catch-all for file operations, whose detail lives in
   * `metadata.action`.
   *
   * These values are **the ones the controller actually writes** — `file.write`
   * and not `write`. My first version assumed the latter: the mapping matched
   * nothing and the whole file log read "Changed the server". A test that
   * validates an invented contract proves nothing.
   */
  it('tells the file operations apart', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.write', file: 'paper.yml' }),
    ).toBe('Edited the file "paper.yml".');

    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'upload', name: 'plugin.jar' }),
    ).toBe('Uploaded the file "plugin.jar".');

    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, {
        action: 'file.create-directory',
        directory: '/plugins',
      }),
    ).toBe('Created the folder "/plugins".');
  });

  // The plural reads: "Deleted a file" is not the same information as
  // "Deleted 42 files".
  it('counts the deleted files', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.delete', files: ['a', 'b'] }),
    ).toBe('Deleted 2 files.');
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.delete', files: ['a'] }),
    ).toBe('Deleted a file.');
  });

  // The same event is written by the user who asks for the backup and by the
  // daemon that reports its verdict: confusing them would show "started" where
  // the daemon says "failed".
  it('tells a backup request from its verdict', () => {
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { name: 'Nightly' })).toContain('Started');
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { successful: true })).toContain('finished');
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { successful: false })).toContain('failed');
  });

  it('reports the failures of a scheduled task', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SCHEDULE_RUN, { schedule: 'Night', failures: ['step 2'] }),
    ).toContain('1 failure');
    expect(describeEvent(AUDIT_EVENTS.SCHEDULE_RUN, { schedule: 'Night', failures: [] })).toContain(
      'ran.',
    );
  });

  // A log meant to be exhaustive must hold no empty lines: failing a sentence,
  // the technical identifier beats nothing.
  it('returns the raw identifier for an unknown event', () => {
    expect(describeEvent('something.brand.new', {})).toBe('something.brand.new');
  });

  it('tolerates absent or badly typed metadata', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_COMMAND, {})).toBe('Ran in the console.');
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 42 })).toBe(
      'Changed the server state.',
    );
  });
});
