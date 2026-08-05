import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as icons from './icons';

const SOURCE = join(import.meta.dirname, '..');

/**
 * The panel drew its icons as literal characters until recently — ⌂ ⚙ ▦ ▤ ◍ ◫
 * ❐ ⚿ ⧉ ✎, plus three emoji. Whether they appeared at all depended on the
 * visitor's fonts, and the rarer ones showed as an empty box.
 *
 * That is the kind of thing that creeps back one component at a time, which is
 * why this reads the source rather than the components.
 */
describe('the icon set', () => {
  it('exports a component for every icon, each carrying a path', () => {
    const names = Object.keys(icons);
    expect(names.length).toBeGreaterThan(20);

    for (const name of names) {
      expect(name).toMatch(/Icon$/);
    }
  });

  it('draws on the grid Material Symbols uses', () => {
    const source = readFileSync(join(SOURCE, 'components', 'icons.tsx'), 'utf8');

    // The origin sits on the baseline, hence the negative y. An icon pasted
    // from elsewhere on a 0 0 24 24 grid would render at a fraction of its size
    // rather than fail, which is exactly the sort of thing nobody notices.
    expect(source).toContain('viewBox="0 -960 960 960"');
    expect(source).not.toContain('0 0 24 24');
  });

  it('holds no icon with an empty path', () => {
    const source = readFileSync(join(SOURCE, 'components', 'icons.tsx'), 'utf8');
    const paths = [...source.matchAll(/<path d="([^"]*)"/g)].map((match) => match[1] ?? '');

    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) {
      expect(path.length).toBeGreaterThan(20);
    }
  });

  // The glyphs that were there before, and the emoji that came with them.
  it('leaves no Unicode glyph standing in for an icon', () => {
    const forbidden = ['⌂', '▦', '▤', '◍', '◫', '❐', '⚿', '⧉', '✎', '↱', '⏻', '🗜', '📦', '🗑'];
    const offenders: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);

        if (entry.isDirectory()) {
          walk(full);
          continue;
        }

        if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.spec.ts')) {
          continue;
        }

        // Comment lines are skipped rather than the file: `icons.tsx` names
        // these glyphs in its header to say what it replaced, and a check that
        // forbade writing about the problem would be a poor guard against it.
        const code = readFileSync(full, 'utf8')
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');

        for (const glyph of forbidden) {
          if (code.includes(glyph)) {
            offenders.push(`${entry.name}: ${glyph}`);
          }
        }
      }
    };

    walk(SOURCE);

    expect(offenders).toEqual([]);
  });
});
