import { describe, expect, it } from 'vitest';
import { parseFlags, textOf } from './flags.js';

describe('parseFlags', () => {
  it('lit une option et sa valeur', () => {
    expect(parseFlags(['--username', 'julien']).get('username')).toBe('julien');
  });

  it('accepte la forme collée', () => {
    expect(parseFlags(['--username=julien']).get('username')).toBe('julien');
  });

  it('garde une valeur contenant un signe égal', () => {
    // Un mot de passe engendré en base64 se termine souvent par « = ».
    expect(parseFlags(['--password=aG9wcGVy==']).get('password')).toBe('aG9wcGVy==');
  });

  it('traite une option sans valeur comme un drapeau', () => {
    expect(parseFlags(['--admin']).get('admin')).toBe(true);
  });

  it('ne prend pas l’option suivante pour la valeur d’un drapeau', () => {
    // Le piège : `--admin --username x` doit créer un administrateur nommé x,
    // et non un utilisateur ordinaire nommé x avec `admin=--username`.
    const flags = parseFlags(['--admin', '--username', 'x']);

    expect(flags.get('admin')).toBe(true);
    expect(flags.get('username')).toBe('x');
  });

  it('ignore ce qui n’est pas une option', () => {
    expect([...parseFlags(['doctor', 'bruit', '--verbose']).keys()]).toEqual(['verbose']);
  });

  it('retient la dernière valeur d’une option répétée', () => {
    expect(parseFlags(['--name', 'a', '--name', 'b']).get('name')).toBe('b');
  });

  it('accepte une valeur vide explicite', () => {
    expect(parseFlags(['--description=']).get('description')).toBe('');
  });
});

describe('textOf', () => {
  it('rend la valeur textuelle', () => {
    expect(textOf(parseFlags(['--name', 'paris']), 'name')).toBe('paris');
  });

  it('rend undefined pour une option absente', () => {
    expect(textOf(parseFlags([]), 'name')).toBeUndefined();
  });

  it('rend undefined pour une option nue', () => {
    // `--password` sans valeur ne doit pas passer pour un mot de passe vide :
    // il serait accepté par le schéma, haché, et impossible à retrouver.
    expect(textOf(parseFlags(['--password']), 'password')).toBeUndefined();
  });
});
