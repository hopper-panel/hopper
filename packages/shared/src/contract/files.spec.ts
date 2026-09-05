import { describe, expect, it } from 'vitest';
import { BINARY_SNIFF_BYTES, isProbablyBinaryName, looksBinary } from './files.js';

/**
 * What decides whether a file opens in the editor.
 *
 * The two answers are deliberately unequal: the name only rules things *out*,
 * cheaply and fallibly, while the bytes rule things *in*. The tests below are
 * mostly about the second half of that — the files an allow list used to
 * refuse, which are the reason this exists.
 */

describe('isProbablyBinaryName', () => {
  it('refuses what is certainly not text', () => {
    for (const name of ['plugin.jar', 'world/r.0.0.mca', 'logo.png', 'backup.tar.gz']) {
      expect(isProbablyBinaryName(name)).toBe(true);
    }
  });

  it('accepts the extensions no allow list ever contained', () => {
    // Every one of these was a download before, on a server that was not a
    // vanilla Minecraft: Garry's Mod, Skript, a datapack, a Python bot.
    for (const name of ['autorun.lua', 'menu.sk', 'tick.mcfunction', 'bot.py', 'index.js']) {
      expect(isProbablyBinaryName(name)).toBe(false);
    }
  });

  it('accepts a file with no extension at all', () => {
    // `Dockerfile`, `Procfile`, `start` — a name with no dot is not a name
    // about which anything is known.
    for (const name of ['Dockerfile', 'start', 'README']) {
      expect(isProbablyBinaryName(name)).toBe(false);
    }
  });

  it('does not read a hidden file as an extension', () => {
    // `.gitignore` is text; nothing in it says otherwise but the leading dot.
    for (const name of ['.gitignore', '.env', '.editorconfig']) {
      expect(isProbablyBinaryName(name)).toBe(false);
    }
  });

  it('ignores the case of the extension', () => {
    expect(isProbablyBinaryName('SERVER.JAR')).toBe(true);
  });
});

describe('looksBinary', () => {
  it('calls a NUL byte binary', () => {
    expect(looksBinary(Uint8Array.from([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it('lets ordinary text through', () => {
    expect(looksBinary(new TextEncoder().encode('hook.Add("Think", "x", fn)\n'))).toBe(false);
  });

  it('lets Latin-1 through, which is not UTF-8 and is still edited every day', () => {
    // `server.properties` written by a decade of panels: the accented byte is
    // 0xE9, invalid UTF-8, and refusing it would refuse the file people came
    // to edit. Only a NUL decides.
    expect(looksBinary(Uint8Array.from([0x6d, 0x6f, 0x74, 0x64, 0x3d, 0xe9, 0x74]))).toBe(false);
  });

  it('accepts an empty file', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('looks no further than the sniffed head', () => {
    // The caller reads that much and no more; a NUL beyond it is not seen, and
    // that is the trade the constant makes.
    const head = new Uint8Array(BINARY_SNIFF_BYTES + 1);
    head.fill(0x61);
    head[BINARY_SNIFF_BYTES] = 0;

    expect(looksBinary(head)).toBe(false);
  });
});
