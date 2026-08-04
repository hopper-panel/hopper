import { describe, expect, it } from 'vitest';
import { buildSftpUsername, parseSftpUsername } from './sftp-username.js';

describe('parseSftpUsername', () => {
  it('découpe un nom valide', () => {
    expect(parseSftpUsername('julien.b10a05a8')).toEqual({
      username: 'julien',
      serverIdPrefix: 'b10a05a8',
    });
  });

  it('accepte les tirets et tirets bas', () => {
    expect(parseSftpUsername('mon_staff-01.b10a05a8')?.username).toBe('mon_staff-01');
  });

  it('normalise le préfixe en minuscules', () => {
    expect(parseSftpUsername('julien.B10A05A8')?.serverIdPrefix).toBe('b10a05a8');
  });

  it.each([
    ['sans point', 'julien'],
    ['préfixe vide', 'julien.'],
    ['utilisateur vide', '.b10a05a8'],
    ['préfixe trop court', 'julien.b10a05'],
    ['préfixe trop long', 'julien.b10a05a8f'],
    ['préfixe non hexadécimal', 'julien.zzzzzzzz'],
    ['utilisateur avec espace', 'mon staff.b10a05a8'],
    ['chaîne vide', ''],
  ])('refuse : %s', (_label, raw) => {
    expect(parseSftpUsername(raw)).toBeNull();
  });

  // Un nom d'utilisateur ne peut pas contenir de point aujourd'hui, mais couper
  // sur le dernier rend le format robuste si cette règle changeait.
  it('découpe sur le dernier point', () => {
    expect(parseSftpUsername('a.b.b10a05a8')).toBeNull();
  });
});

describe('buildSftpUsername', () => {
  it('assemble le nom affiché à l’utilisateur', () => {
    expect(buildSftpUsername('julien', 'b10a05a8-a828-4084-9ec4-909969e73c93')).toBe(
      'julien.b10a05a8',
    );
  });

  it('produit un nom que l’analyseur sait relire', () => {
    const built = buildSftpUsername('julien', 'b10a05a8-a828-4084-9ec4-909969e73c93');
    expect(parseSftpUsername(built)).toEqual({ username: 'julien', serverIdPrefix: 'b10a05a8' });
  });
});
