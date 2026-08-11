import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFlags } from '../flags.js';
import { settingsList, settingsSet } from './settings.js';

/**
 * Setting the panel's language and name from a shell.
 *
 * The installer's own use. Both were already settings — defaulted in code,
 * editable from the administration — which put them behind a sign-in, in
 * English, on a panel called Hopper. Everything an operator was asked at
 * install time had to end up somewhere, and this is where these two land.
 *
 * The values arrive as text from a shell, and that is the whole difficulty:
 * `--value 8000` is a string, the schema wants a number, and a refusal for a
 * value that is perfectly correct is the kind of thing a scripted install
 * dies on at three in the morning.
 */

function contextWith(settings: {
  update?: (dto: unknown) => Promise<unknown>;
  all?: () => Promise<Record<string, unknown>>;
}): INestApplicationContext {
  return { get: () => settings } as unknown as INestApplicationContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings:set', () => {
  it('writes a string setting as it was typed', async () => {
    const update = vi.fn().mockResolvedValue({});

    await settingsSet(
      contextWith({ update }),
      parseFlags(['--key', 'defaultLocale', '--value', 'fr']),
    );

    expect(update).toHaveBeenCalledWith({ defaultLocale: 'fr' });
  });

  it('writes a number as a number', async () => {
    // `{ nodeTimeoutMs: "8000" }` is refused by the schema, and the refusal
    // would reach an operator as "Invalid value" for something they typed
    // exactly right.
    const update = vi.fn().mockResolvedValue({});

    await settingsSet(contextWith({ update }), parseFlags(['--key=nodeTimeoutMs', '--value=8000']));

    expect(update).toHaveBeenCalledWith({ nodeTimeoutMs: 8000 });
  });

  it('writes a boolean as a boolean', async () => {
    const update = vi.fn().mockResolvedValue({});

    await settingsSet(contextWith({ update }), parseFlags(['--key=mailEnabled', '--value=true']));

    expect(update).toHaveBeenCalledWith({ mailEnabled: true });
  });

  it('refuses a language nothing is written in, and names the ones that are', async () => {
    const update = vi.fn();
    const exit = fakeExit();

    await expect(
      settingsSet(contextWith({ update }), parseFlags(['--key=defaultLocale', '--value=kr'])),
    ).rejects.toThrow('exit');

    expect(update).not.toHaveBeenCalled();
    expect(exit.stderr).toMatch(/defaultLocale/);
  });

  it('names the keys it knows when given one it does not', async () => {
    // The caller is usually a script. "Unknown setting" without the list is a
    // trip to the source code.
    const exit = fakeExit();

    await expect(
      settingsSet(contextWith({}), parseFlags(['--key=langauge', '--value=fr'])),
    ).rejects.toThrow('exit');

    expect(exit.stderr).toMatch(/defaultLocale/);
  });
});

describe('settings:list', () => {
  it('never prints a secret, even to root at a terminal', async () => {
    // This output ends up in installation logs and in pasted bug reports.
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    await settingsList(
      contextWith({
        all: () =>
          Promise.resolve({
            panelName: 'Hopper',
            defaultLocale: 'fr',
            mailPassword: 'hunter2',
          }),
      }),
    );

    const output = written.join('');

    expect(output).toContain('fr');
    expect(output).not.toContain('hunter2');
  });
});

/** `fatal` ends the process; here it throws instead, so the test survives it. */
function fakeExit(): { stderr: string } {
  const captured = { stderr: '' };

  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    captured.stderr += String(chunk);
    return true;
  });

  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });

  return captured;
}
