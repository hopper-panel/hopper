import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOG, catalogGroups } from './index.js';
import { templateDefinitionSchema } from './definition.js';

describe('catalogue de templates', () => {
  it('contient des templates', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThan(0);
  });

  it('valide chaque définition', () => {
    for (const template of TEMPLATE_CATALOG) {
      expect(() => templateDefinitionSchema.parse(template)).not.toThrow();
    }
  });

  // Les clés servent d'identifiant d'upsert : un doublon ferait qu'un template
  // en écraserait un autre à chaque amorçage.
  it('utilise des clés uniques', () => {
    const keys = TEMPLATE_CATALOG.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('déclare des groupes connus', () => {
    expect(catalogGroups().length).toBeGreaterThan(0);
    for (const group of catalogGroups()) {
      expect(group.trim()).not.toBe('');
    }
  });

  describe('chaque template', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s est cohérent',
      (_name, template) => {
        // Une image par défaut est indispensable : c'est celle retenue quand
        // l'utilisateur n'en choisit pas.
        expect(template.dockerImages.length).toBeGreaterThan(0);

        // Une regex de détection invalide ne lèverait qu'au démarrage du
        // premier serveur, longtemps après l'erreur.
        if (template.startupDetection) {
          expect(() => new RegExp(template.startupDetection!)).not.toThrow();
        }

        expect(template.stopCommand).toMatch(/^(command:.+|signal:SIG(TERM|INT|KILL))$/);
      },
    );
  });

  describe('scripts d’installation', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s échoue bruyamment',
      (_name, template) => {
        // Sans `set -e`, une commande en échec laisse le script continuer et
        // l'installation est déclarée réussie avec un volume incomplet.
        expect(template.installScript).toContain('set -e');

        // Sans `--fail`, curl écrit une page d'erreur HTTP dans le fichier de
        // destination et renvoie 0. C'est ainsi que l'arrêt de l'API v2 de
        // PaperMC produisait des .jar de zéro octet.
        const curlCalls = template.installScript.match(/curl [^\n|]*-o /g) ?? [];
        for (const call of curlCalls) {
          expect(call).toContain('--fail');
        }
      },
    );

    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s ne référence que des variables déclarées',
      (_name, template) => {
        const declared = new Set([
          ...template.variables.map((variable) => variable.envVariable),
          // Fournies par Hopper à tous les serveurs.
          'SERVER_MEMORY',
          'SERVER_IP',
          'SERVER_PORT',
        ]);

        // `${VAR}` dans le script, `{{VAR}}` dans la commande de démarrage.
        const used = [
          ...template.installScript.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g),
          ...template.startup.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g),
        ].map((match) => match[1]!);

        // Les variables locales du script (majuscules mais assignées sur place)
        // sont écartées : seules comptent celles que Hopper doit fournir.
        // `\s*` en tête : une assignation dans un bloc `if` est indentée, et
        // l'ancrage strict la faisait passer pour une variable non déclarée.
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
