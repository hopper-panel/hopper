import { describe, expect, it } from 'vitest';
import { CronError, formatCron, nextOccurrence, parseField, validateCron } from './cron.js';

/**
 * Raccourci de lecture : `at('2026-08-03 10:00')`.
 *
 * Découpage par position plutôt que par `split` : ce dernier rend des éléments
 * possiblement absents, qu'il faudrait ensuite écarter à coups d'assertions
 * pour un format entièrement sous notre contrôle.
 */
function at(text: string): Date {
  return new Date(
    Number(text.slice(0, 4)),
    Number(text.slice(5, 7)) - 1,
    Number(text.slice(8, 10)),
    Number(text.slice(11, 13)),
    Number(text.slice(14, 16)),
    0,
    0,
  );
}

function iso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

describe('parseField', () => {
  it('développe l’astérisque sur tout le domaine', () => {
    expect(parseField('*', 'hour')).toHaveLength(24);
    expect(parseField('*', 'minute')).toHaveLength(60);
    expect(parseField('*', 'dayOfMonth')[0]).toBe(1);
  });

  it('accepte une valeur, une liste et un intervalle', () => {
    expect(parseField('5', 'hour')).toEqual([5]);
    expect(parseField('1,3,5', 'hour')).toEqual([1, 3, 5]);
    expect(parseField('1-4', 'hour')).toEqual([1, 2, 3, 4]);
  });

  it('accepte un pas', () => {
    expect(parseField('*/15', 'minute')).toEqual([0, 15, 30, 45]);
    expect(parseField('10-30/10', 'minute')).toEqual([10, 20, 30]);
  });

  // `5/15` parcourt le reste du domaine, comme dans une crontab : sans cela il
  // ne désignerait que la minute 5 et la tâche ne tournerait qu'une fois par
  // heure au lieu de quatre.
  it('poursuit jusqu’au bout du domaine avec un pas sans borne haute', () => {
    expect(parseField('5/15', 'minute')).toEqual([5, 20, 35, 50]);
  });

  it('déduplique et trie', () => {
    expect(parseField('5,1,5,3', 'hour')).toEqual([1, 3, 5]);
  });

  // Comportement historique de cron, que toute crontab existante suppose.
  it('ramène 7 sur 0 pour dimanche', () => {
    expect(parseField('7', 'dayOfWeek')).toEqual([0]);
    expect(parseField('0,7', 'dayOfWeek')).toEqual([0]);
  });

  describe('refus', () => {
    // Refuser à la création plutôt qu'accepter une expression qui ne se
    // déclencherait jamais : l'utilisateur croirait sa tâche planifiée.
    it.each([
      ['', 'minute'],
      ['abc', 'hour'],
      ['60', 'minute'],
      ['24', 'hour'],
      ['0', 'dayOfMonth'],
      ['32', 'dayOfMonth'],
      ['13', 'month'],
      ['8', 'dayOfWeek'],
      ['*/0', 'minute'],
      ['5-1', 'hour'],
      ['1-2-3', 'hour'],
    ] as const)('refuse « %s » pour %s', (raw, field) => {
      expect(() => parseField(raw, field)).toThrow(CronError);
    });
  });
});

describe('nextOccurrence', () => {
  it('trouve la prochaine minute correspondante', () => {
    const next = nextOccurrence(
      { minute: '30', hour: '4', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-04 04:30');
  });

  // Strictement postérieure : sinon une tâche qui vient de tourner serait
  // immédiatement redéclenchée, en boucle.
  it('est strictement postérieure à l’instant fourni', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-03 11:00');
  });

  it('gère un pas sur les minutes', () => {
    const next = nextOccurrence(
      { minute: '*/15', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      at('2026-08-03 10:07'),
    );

    expect(iso(next)).toBe('2026-08-03 10:15');
  });

  it('passe au mois suivant', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '0', dayOfMonth: '1', month: '*', dayOfWeek: '*' },
      at('2026-08-15 12:00'),
    );

    expect(iso(next)).toBe('2026-09-01 00:00');
  });

  it('trouve un 29 février', () => {
    const next = nextOccurrence(
      { minute: '0', hour: '0', dayOfMonth: '29', month: '2', dayOfWeek: '*' },
      at('2026-03-01 00:00'),
    );

    expect(iso(next)).toBe('2028-02-29 00:00');
  });

  it('respecte le jour de la semaine', () => {
    // 3 août 2026 est un lundi ; le mardi suivant est le 4.
    const next = nextOccurrence(
      { minute: '0', hour: '6', dayOfMonth: '*', month: '*', dayOfWeek: '2' },
      at('2026-08-03 10:00'),
    );

    expect(iso(next)).toBe('2026-08-04 06:00');
    expect(next.getDay()).toBe(2);
  });

  /**
   * Le piège classique de cron, et celui qui fait redémarrer un serveur au
   * mauvais moment : quand le jour du mois **et** le jour de la semaine sont
   * tous deux restreints, ils se combinent en **ou**, pas en **et**.
   */
  describe('croisement jour du mois / jour de la semaine', () => {
    it('combine en OU quand les deux sont restreints', () => {
      const expression = { minute: '0', hour: '0', dayOfMonth: '15', month: '8', dayOfWeek: '1' };

      // Le lundi 10 août arrive avant le 15 : c'est bien un OU.
      const next = nextOccurrence(expression, at('2026-08-05 12:00'));

      expect(iso(next)).toBe('2026-08-10 00:00');
      expect(next.getDay()).toBe(1);
    });

    it('combine en ET dès que l’un des deux est libre', () => {
      // Jour du mois restreint, jour de semaine libre : seul le 15 compte.
      const next = nextOccurrence(
        { minute: '0', hour: '0', dayOfMonth: '15', month: '8', dayOfWeek: '*' },
        at('2026-08-05 12:00'),
      );

      expect(iso(next)).toBe('2026-08-15 00:00');
    });
  });

  // Une expression impossible doit se signaler, pas faire tourner la recherche
  // indéfiniment ni rendre une date fantaisiste.
  it('refuse une expression qui ne correspond à aucune date', () => {
    expect(() =>
      nextOccurrence(
        { minute: '0', hour: '0', dayOfMonth: '30', month: '2', dayOfWeek: '*' },
        at('2026-01-01 00:00'),
      ),
    ).toThrow(CronError);
  });

  // Les secondes de l'instant de départ ne doivent pas décaler le résultat.
  it('ignore les secondes de l’instant fourni', () => {
    const from = at('2026-08-03 10:00');
    from.setSeconds(59, 999);

    const next = nextOccurrence(
      { minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
      from,
    );

    expect(iso(next)).toBe('2026-08-03 10:01');
    expect(next.getSeconds()).toBe(0);
  });
});

describe('validateCron', () => {
  it('accepte une expression complète', () => {
    expect(() =>
      validateCron({ minute: '0', hour: '5', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' }),
    ).not.toThrow();
  });

  it('signale le champ fautif', () => {
    expect(() =>
      validateCron({ minute: '0', hour: '99', dayOfMonth: '*', month: '*', dayOfWeek: '*' }),
    ).toThrow(/heure/);
  });
});

describe('formatCron', () => {
  it('rend la forme habituelle', () => {
    expect(
      formatCron({ minute: '0', hour: '5', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' }),
    ).toBe('0 5 * * 1-5');
  });
});
