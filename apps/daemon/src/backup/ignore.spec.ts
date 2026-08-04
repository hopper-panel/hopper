import { describe, expect, it } from 'vitest';
import { ALWAYS_IGNORED, IgnoreList } from './ignore.js';

describe('IgnoreList', () => {
  it('n’exclut rien sans motif', () => {
    const list = new IgnoreList([]);

    expect(list.isEmpty).toBe(true);
    expect(list.ignores('world/level.dat')).toBe(false);
  });

  it('ignore les commentaires et les lignes vides', () => {
    const list = new IgnoreList(['# les journaux', '', '   ', '*.log']);

    expect(list.ignores('latest.log')).toBe(true);
    expect(list.ignores('server.properties')).toBe(false);
  });

  // Comportement `.gitignore` : un motif sans barre vaut à toute profondeur.
  // C'est ce qui rend `*.log` utile — les journaux d'un serveur Minecraft sont
  // éparpillés dans les répertoires de plugins.
  describe('motif non ancré', () => {
    it('s’applique à toute profondeur', () => {
      const list = new IgnoreList(['*.log']);

      expect(list.ignores('latest.log')).toBe(true);
      expect(list.ignores('logs/2026-08-03.log')).toBe(true);
      expect(list.ignores('plugins/CoreProtect/debug.log')).toBe(true);
    });

    it('exclut aussi le contenu de ce qu’il désigne', () => {
      const list = new IgnoreList(['cache']);

      expect(list.ignores('cache', true)).toBe(true);
      expect(list.ignores('cache/mojang.json')).toBe(true);
      expect(list.ignores('plugins/cache/x.dat')).toBe(true);
    });
  });

  describe('motif ancré', () => {
    it('ne vaut qu’à la racine', () => {
      const list = new IgnoreList(['/logs']);

      expect(list.ignores('logs/latest.log')).toBe(true);
      expect(list.ignores('plugins/logs/latest.log')).toBe(false);
    });

    // Une barre au milieu ancre aussi, comme dans `.gitignore`.
    it('est ancré dès qu’il contient une barre', () => {
      const list = new IgnoreList(['plugins/*/data']);

      expect(list.ignores('plugins/Essentials/data')).toBe(true);
      expect(list.ignores('x/plugins/Essentials/data')).toBe(false);
    });
  });

  describe('joker', () => {
    it('*, un seul segment', () => {
      const list = new IgnoreList(['plugins/*.jar']);

      expect(list.ignores('plugins/Essentials.jar')).toBe(true);
      expect(list.ignores('plugins/sub/Essentials.jar')).toBe(false);
    });

    it('**, plusieurs segments', () => {
      const list = new IgnoreList(['plugins/**/*.jar']);

      expect(list.ignores('plugins/sub/Essentials.jar')).toBe(true);
      expect(list.ignores('plugins/a/b/c/Essentials.jar')).toBe(true);
    });
  });

  it('ne vise que les répertoires avec une barre finale', () => {
    const list = new IgnoreList(['cache/']);

    expect(list.ignores('cache', true)).toBe(true);
    // Un *fichier* nommé « cache » n'est pas ce que la règle visait.
    expect(list.ignores('cache', false)).toBe(false);
  });

  // La raison d'être de `!` : c'est la dernière règle correspondante qui
  // décide. Un parcours qui s'arrêterait à la première correspondance rendrait
  // la négation inopérante — et l'utilisateur perdrait un fichier qu'il croyait
  // avoir sauvé.
  describe('négation', () => {
    it('réintègre ce qu’une règle précédente excluait', () => {
      const list = new IgnoreList(['*.log', '!important.log']);

      expect(list.ignores('debug.log')).toBe(true);
      expect(list.ignores('important.log')).toBe(false);
    });

    it('l’ordre compte', () => {
      const list = new IgnoreList(['!important.log', '*.log']);

      expect(list.ignores('important.log')).toBe(true);
    });
  });

  // Un chemin séparé par des antislashs ne doit pas échapper aux règles :
  // l'archive est produite sur Linux, mais les tests tournent aussi sous
  // Windows et un jour quelqu'un passera un chemin natif.
  it('normalise les séparateurs', () => {
    const list = new IgnoreList(['logs/*.log']);

    expect(list.ignores('logs\\latest.log')).toBe(true);
    expect(list.ignores('./logs/latest.log')).toBe(true);
  });

  it('ne prétend jamais exclure la racine', () => {
    const list = new IgnoreList(['**']);

    expect(list.ignores('')).toBe(false);
    expect(list.ignores('.')).toBe(false);
  });

  describe('canPrune', () => {
    // Descendre dans un répertoire dont rien ne sortira coûte un appel système
    // par entrée ; sur un serveur qui en compte des dizaines de milliers, c'est
    // l'essentiel du temps de sauvegarde.
    it('permet de sauter un répertoire entièrement exclu', () => {
      expect(new IgnoreList(['cache/']).canPrune('cache')).toBe(true);
    });

    // Mais dès qu'une règle peut réintégrer quelque chose, il faut ouvrir le
    // répertoire : élaguer ferait disparaître un fichier explicitement sauvé.
    it('interdit l’élagage en présence d’une négation', () => {
      const list = new IgnoreList(['cache/', '!cache/garder.dat']);

      expect(list.ignores('cache', true)).toBe(true);
      expect(list.canPrune('cache')).toBe(false);
    });
  });
});

describe('ALWAYS_IGNORED', () => {
  // `session.lock` restauré fait croire au moteur de monde qu'une autre
  // instance écrit déjà dedans : le serveur refuse alors de démarrer, sur une
  // erreur qui ne mentionne pas la sauvegarde.
  it('écarte le verrou de session et les vidages de la JVM', () => {
    const list = new IgnoreList(ALWAYS_IGNORED);

    expect(list.ignores('world/session.lock')).toBe(true);
    expect(list.ignores('hs_err_pid1234.log')).toBe(true);
    expect(list.ignores('core.4242')).toBe(true);
    expect(list.ignores('world/level.dat')).toBe(false);
  });
});
