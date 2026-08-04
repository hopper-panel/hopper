import { describe, expect, it } from 'vitest';
import { ConsoleBuffer, LineAssembler, MAX_LINE_LENGTH } from './console-buffer.js';

describe('LineAssembler', () => {
  it('découpe un fragment contenant plusieurs lignes', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('une\ndeux\ntrois\n')).toEqual(['une', 'deux', 'trois']);
  });

  // Sans ré-assemblage, une ligne coupée en deux paquets ne matcherait jamais la
  // regex de détection de démarrage.
  it('recolle une ligne arrivée en plusieurs fragments', () => {
    const assembler = new LineAssembler();

    expect(assembler.push('Done (12.3')).toEqual([]);
    expect(assembler.push('s)! For help')).toEqual([]);
    expect(assembler.push(', type "help"\n')).toEqual(['Done (12.3s)! For help, type "help"']);
  });

  it('retient une ligne incomplète jusqu’à son retour à la ligne', () => {
    const assembler = new LineAssembler();

    expect(assembler.push('une\npartielle')).toEqual(['une']);
    expect(assembler.push('-suite\n')).toEqual(['partielle-suite']);
  });

  it('retire les retours chariot des CRLF', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('windows\r\nunix\n')).toEqual(['windows', 'unix']);
  });

  it('conserve les lignes vides', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('restitue la ligne partielle au flush', () => {
    const assembler = new LineAssembler();
    assembler.push('sans fin');
    expect(assembler.flush()).toEqual(['sans fin']);
    expect(assembler.flush()).toEqual([]);
  });

  it('tronque une ligne démesurée', () => {
    const assembler = new LineAssembler();
    const [line] = assembler.push('x'.repeat(MAX_LINE_LENGTH + 5000) + '\n');

    expect(line!.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 30);
    expect(line).toContain('tronquée');
  });

  // Un flux binaire sans aucun retour à la ligne ferait grossir le tampon
  // jusqu'à épuiser la mémoire du daemon.
  it('coupe un flux sans retour à la ligne au lieu de gonfler indéfiniment', () => {
    const assembler = new LineAssembler();
    let emitted: string[] = [];

    for (let index = 0; index < 20; index += 1) {
      emitted = emitted.concat(assembler.push('y'.repeat(1000)));
    }

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[0]).toContain('tronquée');
  });
});

describe('ConsoleBuffer', () => {
  it('conserve les lignes dans l’ordre', () => {
    const buffer = new ConsoleBuffer(10);
    buffer.pushAll(['a', 'b', 'c']);
    expect(buffer.snapshot()).toEqual(['a', 'b', 'c']);
  });

  it('ne dépasse jamais sa capacité', () => {
    const buffer = new ConsoleBuffer(3);
    buffer.pushAll(['a', 'b', 'c', 'd', 'e']);

    expect(buffer.size).toBe(3);
    expect(buffer.snapshot()).toEqual(['c', 'd', 'e']);
  });

  it('retourne une copie, pas la référence interne', () => {
    const buffer = new ConsoleBuffer(5);
    buffer.push('a');

    const snapshot = buffer.snapshot();
    snapshot.push('injecté');

    expect(buffer.snapshot()).toEqual(['a']);
  });

  it('se vide sur demande', () => {
    const buffer = new ConsoleBuffer(5);
    buffer.pushAll(['a', 'b']);
    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
  });

  it('refuse une capacité nulle', () => {
    expect(() => new ConsoleBuffer(0)).toThrow();
  });
});
