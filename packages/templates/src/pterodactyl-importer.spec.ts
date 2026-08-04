import { describe, expect, it } from 'vitest';
import { EggImportError, importPterodactylEgg, slugify } from './pterodactyl-importer.js';

const OPTIONS = { group: 'Minecraft: Java Edition' };

/** Egg minimal mais complet, au format PTDL_v2. */
function makeEgg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { version: 'PTDL_v2' },
    uuid: '0e0b3d1e-4d0e-4d0e-8d0e-4d0e4d0e4d0e',
    name: 'Paper',
    author: 'support@pterodactyl.io',
    description: 'Serveur Paper',
    docker_images: {
      'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
      'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
    },
    startup: 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
    config: {
      files: '{}',
      startup: '{"done": ")! For help, type "}',
      stop: 'stop',
    },
    scripts: {
      installation: {
        script: '#!/bin/bash\ncurl -o server.jar https://example.invalid/paper.jar\n',
        container: 'ghcr.io/pterodactyl/installers:debian',
        entrypoint: 'bash',
      },
    },
    variables: [
      {
        name: 'Server Jar File',
        description: 'The name of the jarfile.',
        env_variable: 'SERVER_JARFILE',
        default_value: 'server.jar',
        user_viewable: 1,
        user_editable: 1,
        rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
      },
    ],
    ...overrides,
  };
}

describe('importPterodactylEgg', () => {
  it('convertit un egg complet', () => {
    const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

    expect(template.key).toBe('paper');
    expect(template.name).toBe('Paper');
    expect(template.group).toBe('Minecraft: Java Edition');
    expect(template.startup).toContain('{{SERVER_MEMORY}}');
    expect(template.stopCommand).toBe('command:stop');
    expect(template.installEntrypoint).toBe('bash');
    expect(template.importedFromEgg).toBe('0e0b3d1e-4d0e-4d0e-8d0e-4d0e4d0e4d0e');
  });

  // Un objet JSON perdrait son ordre en base ; l'ordre de l'egg reflète
  // l'intention de son auteur, la première image étant celle qu'il recommande.
  it("conserve l'ordre des images Docker", () => {
    const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

    expect(template.dockerImages.map((option) => option.name)).toEqual(['Java 21', 'Java 17']);
  });

  it('accepte le format PTDL_v1 : images en tableau', () => {
    const { template } = importPterodactylEgg(
      makeEgg({ docker_images: ['quay.io/pterodactyl/core:java'] }),
      OPTIONS,
    );

    expect(template.dockerImages).toEqual([
      { name: 'quay.io/pterodactyl/core:java', image: 'quay.io/pterodactyl/core:java' },
    ]);
  });

  it('accepte le format PTDL_v1 : image unique', () => {
    const egg = makeEgg({ image: 'quay.io/pterodactyl/core:java' });
    delete egg.docker_images;

    const { template } = importPterodactylEgg(egg, OPTIONS);
    expect(template.dockerImages).toHaveLength(1);
  });

  describe('marqueur de démarrage', () => {
    // Pterodactyl stocke une sous-chaîne, Hopper compile une regex : sans
    // échappement, « ) » produirait une expression invalide et le serveur ne
    // passerait jamais « en ligne ».
    it('échappe les caractères spéciaux', () => {
      const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

      expect(template.startupDetection).toBe('\\)! For help, type ');
      expect(() => new RegExp(template.startupDetection!)).not.toThrow();
    });

    it('accepte un bloc config déjà décodé', () => {
      const egg = makeEgg({ config: { startup: { done: 'Done!' }, stop: 'stop' } });
      const { template } = importPterodactylEgg(egg, OPTIONS);

      expect(template.startupDetection).toBe('Done!');
    });

    it('gère un tableau de marqueurs et le signale', () => {
      const egg = makeEgg({ config: { startup: { done: ['Done!', 'Ready'] }, stop: 'stop' } });
      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.template.startupDetection).toBe('Done!');
      expect(result.warnings.some((w) => w.includes('plusieurs marqueurs'))).toBe(true);
    });

    it('signale son absence', () => {
      const egg = makeEgg({ config: { stop: 'stop' } });
      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.template.startupDetection).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('marqueur de démarrage'))).toBe(true);
    });
  });

  describe("commande d'arrêt", () => {
    it.each([
      ['stop', 'command:stop'],
      ['end', 'command:end'],
      ['^C', 'signal:SIGINT'],
      ['SIGINT', 'signal:SIGINT'],
      ['SIGTERM', 'signal:SIGTERM'],
    ])('traduit « %s » en %s', (stop, expected) => {
      const { template } = importPterodactylEgg(makeEgg({ config: { stop } }), OPTIONS);
      expect(template.stopCommand).toBe(expected);
    });

    it('retombe sur SIGTERM et le signale', () => {
      const result = importPterodactylEgg(makeEgg({ config: {} }), OPTIONS);

      expect(result.template.stopCommand).toBe('signal:SIGTERM');
      expect(result.warnings.some((w) => w.includes('SIGTERM'))).toBe(true);
    });

    it('avertit sur un arrêt par SIGKILL', () => {
      const result = importPterodactylEgg(makeEgg({ config: { stop: 'SIGKILL' } }), OPTIONS);
      expect(result.warnings.some((w) => w.includes('sans sauvegarde'))).toBe(true);
    });
  });

  describe('variables', () => {
    it('convertit les entiers 0/1 en booléens', () => {
      const { template } = importPterodactylEgg(makeEgg(), OPTIONS);

      expect(template.variables[0]!.userViewable).toBe(true);
      expect(template.variables[0]!.userEditable).toBe(true);
    });

    it('convertit une valeur par défaut numérique en chaîne', () => {
      const egg = makeEgg({
        variables: [{ env_variable: 'MAX_PLAYERS', default_value: 20 }],
      });

      expect(importPterodactylEgg(egg, OPTIONS).template.variables[0]!.defaultValue).toBe('20');
    });

    it('traite une valeur par défaut nulle comme vide', () => {
      const egg = makeEgg({ variables: [{ env_variable: 'MOTD', default_value: null }] });
      expect(importPterodactylEgg(egg, OPTIONS).template.variables[0]!.defaultValue).toBe('');
    });

    // Un nom non conforme ferait échouer l'`export` du script d'installation,
    // avec un message que personne ne relierait à l'egg.
    it('écarte une variable au nom non conforme à POSIX', () => {
      const egg = makeEgg({
        variables: [{ env_variable: 'SERVER-PORT' }, { env_variable: 'VALID_ONE' }],
      });

      const result = importPterodactylEgg(egg, OPTIONS);

      expect(result.template.variables.map((v) => v.envVariable)).toEqual(['VALID_ONE']);
      expect(result.warnings.some((w) => w.includes('SERVER-PORT'))).toBe(true);
    });

    it("n'exige pas de variable", () => {
      const egg = makeEgg({ variables: [] });
      expect(importPterodactylEgg(egg, OPTIONS).template.variables).toEqual([]);
    });
  });

  describe('avertissements', () => {
    it('signale les images étrangères à Hopper', () => {
      const result = importPterodactylEgg(makeEgg(), OPTIONS);
      expect(result.warnings.some((w) => w.includes('durcissement'))).toBe(true);
    });

    it('signale les fichiers de configuration non repris', () => {
      const egg = makeEgg({
        config: { files: '{"server.properties":{"parser":"properties"}}', stop: 'stop' },
      });

      const result = importPterodactylEgg(egg, OPTIONS);
      expect(result.warnings.some((w) => w.includes('fichiers de configuration'))).toBe(true);
    });

    it("signale une révision d'egg inconnue", () => {
      const result = importPterodactylEgg(makeEgg({ meta: { version: 'PTDL_v9' } }), OPTIONS);
      expect(result.warnings.some((w) => w.includes('PTDL_v9'))).toBe(true);
    });
  });

  describe('refus', () => {
    it("refuse un fichier qui n'est pas un egg", () => {
      expect(() => importPterodactylEgg({ hello: 'world' }, OPTIONS)).toThrow(EggImportError);
    });

    it("refuse un egg sans script d'installation", () => {
      const egg = makeEgg({ scripts: { installation: { script: '  ' } } });
      expect(() => importPterodactylEgg(egg, OPTIONS)).toThrow(/script d'installation/);
    });

    it('refuse un egg sans commande de démarrage', () => {
      expect(() => importPterodactylEgg(makeEgg({ startup: '' }), OPTIONS)).toThrow(
        /commande de démarrage/,
      );
    });

    it('refuse un egg sans image Docker', () => {
      const egg = makeEgg();
      delete egg.docker_images;
      expect(() => importPterodactylEgg(egg, OPTIONS)).toThrow(/image Docker/);
    });

    it('expose le détail des problèmes de format', () => {
      try {
        importPterodactylEgg({ name: 123 }, OPTIONS);
        expect.unreachable('l’import aurait dû échouer');
      } catch (error) {
        expect((error as EggImportError).issues.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('slugify', () => {
  it.each([
    ['Paper', 'paper'],
    ['Paper (1.8)', 'paper-1-8'],
    ['  Vanilla  Minecraft ', 'vanilla-minecraft'],
    ['Forgé', 'forge'],
    ['A---B', 'a-b'],
  ])('transforme « %s » en « %s »', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('respecte le format attendu par le schéma', () => {
    expect(slugify('N’importe QUOI !! 2024')).toMatch(/^[a-z0-9-]+$/);
  });

  // Deux imports du même egg doivent produire la même clé : sinon l'upsert
  // créerait un doublon à chaque import.
  it('reste stable pour un nom sans caractère latin', () => {
    const first = slugify('日本語サーバー');
    const second = slugify('日本語サーバー');

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z0-9-]+$/);
    expect(slugify('другой')).not.toBe(first);
  });
});
