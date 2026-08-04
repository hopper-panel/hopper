import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOG, catalogGroups } from './index.js';
import { templateDefinitionSchema } from './definition.js';

describe('catalogue de templates', () => {
  it('holds templates', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThan(0);
  });

  it('validates every definition', () => {
    for (const template of TEMPLATE_CATALOG) {
      expect(() => templateDefinitionSchema.parse(template)).not.toThrow();
    }
  });

  // The keys serve as upsert identifiers: a duplicate would have one template
  // overwrite another on every seed.
  it('uses unique keys', () => {
    const keys = TEMPLATE_CATALOG.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares known groups', () => {
    expect(catalogGroups().length).toBeGreaterThan(0);
    for (const group of catalogGroups()) {
      expect(group.trim()).not.toBe('');
    }
  });

  describe('each template', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s is coherent',
      (_name, template) => {
        // A default image is indispensable: it is the one used when the user
        // picks none.
        expect(template.dockerImages.length).toBeGreaterThan(0);

        // An invalid detection regex would only throw when the first server
        // starts, long after the mistake.
        if (template.startupDetection) {
          expect(() => new RegExp(template.startupDetection!)).not.toThrow();
        }

        expect(template.stopCommand).toMatch(/^(command:.+|signal:SIG(TERM|INT|KILL))$/);
      },
    );
  });

  describe('install scripts', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s fails loudly',
      (_name, template) => {
        // Without `set -e`, a failing command lets the script carry on and the
        // installation is declared successful with an incomplete volume.
        expect(template.installScript).toContain('set -e');

        // Without `--fail`, curl writes an HTTP error page into the destination
        // file and returns 0. That is how the retirement of PaperMC v2 produced
        // zero-byte .jars.
        const curlCalls = template.installScript.match(/curl [^\n|]*-o /g) ?? [];
        for (const call of curlCalls) {
          expect(call).toContain('--fail');
        }
      },
    );

    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s only references declared variables',
      (_name, template) => {
        const declared = new Set([
          ...template.variables.map((variable) => variable.envVariable),
          // Supplied by Hopper to every server.
          'SERVER_MEMORY',
          'SERVER_IP',
          'SERVER_PORT',
        ]);

        // `${VAR}` in the script, `{{VAR}}` in the startup command.
        const used = [
          ...template.installScript.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g),
          ...template.startup.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g),
        ].map((match) => match[1]!);

        // The script's local variables (uppercase but assigned on the spot)
        // are skipped: only those Hopper has to supply count. A leading
        // `\s*`: an assignment inside an `if` block is indented, and strict
        // anchoring made it look like an undeclared variable.
        const assigned = new Set(
          [...template.installScript.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=/gm)].map(
            (match) => match[1]!,
          ),
        );

        const missing = used.filter((name) => !declared.has(name) && !assigned.has(name));

        expect(missing).toEqual([]);
      },
    );
  });
});
