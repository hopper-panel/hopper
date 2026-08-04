import { describe, expect, it } from 'vitest';
import { AUDIT_EVENTS } from '../audit/audit.service.js';
import { describeEvent } from './describe-event.js';

describe('describeEvent', () => {
  it('rend une phrase pour une action de puissance', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 'restart' })).toBe(
      'A redémarré le serveur.',
    );
  });

  it('cite la commande exécutée', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_COMMAND, { command: 'say bonjour' })).toContain(
      'say bonjour',
    );
  });

  /**
   * `server.updated` sert de fourre-tout aux opérations sur fichiers, dont le
   * détail vit dans `metadata.action`.
   *
   * Ces valeurs sont **celles que le contrôleur écrit réellement** — `file.write`
   * et non `write`. Ma première version supposait les secondes : le mappage ne
   * correspondait à rien et tout le journal des fichiers se lisait « A modifié
   * le serveur ». Un test qui valide un contrat inventé ne prouve rien.
   */
  it('distingue les opérations sur fichiers', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.write', file: 'paper.yml' }),
    ).toBe('A modifié le fichier « paper.yml ».');

    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'upload', name: 'plugin.jar' }),
    ).toBe('A envoyé le fichier « plugin.jar ».');

    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, {
        action: 'file.create-directory',
        directory: '/plugins',
      }),
    ).toBe('A créé le dossier « /plugins ».');
  });

  // Le pluriel se lit : « A supprimé un fichier » n'est pas la même
  // information que « A supprimé 42 fichiers ».
  it('compte les fichiers supprimés', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.delete', files: ['a', 'b'] }),
    ).toBe('A supprimé 2 fichiers.');
    expect(
      describeEvent(AUDIT_EVENTS.SERVER_UPDATED, { action: 'file.delete', files: ['a'] }),
    ).toBe('A supprimé un fichier.');
  });

  // Le même événement est écrit par l'utilisateur qui demande la sauvegarde et
  // par le daemon qui en rapporte le verdict : les confondre ferait apparaître
  // « a lancé » là où le daemon dit « a échoué ».
  it('distingue la demande de sauvegarde de son verdict', () => {
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { name: 'Nocturne' })).toContain('A lancé');
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { successful: true })).toContain('terminée');
    expect(describeEvent(AUDIT_EVENTS.BACKUP_CREATED, { successful: false })).toContain('échoué');
  });

  it('signale les échecs d’une tâche planifiée', () => {
    expect(
      describeEvent(AUDIT_EVENTS.SCHEDULE_RUN, { schedule: 'Nuit', failures: ['étape 2'] }),
    ).toContain('1 échec');
    expect(describeEvent(AUDIT_EVENTS.SCHEDULE_RUN, { schedule: 'Nuit', failures: [] })).toContain(
      's’est exécutée.',
    );
  });

  // Un journal censé être exhaustif ne doit pas comporter de lignes vides :
  // faute de phrase, l'identifiant technique vaut mieux que rien.
  it('rend l’identifiant brut pour un événement inconnu', () => {
    expect(describeEvent('quelque.chose.de.neuf', {})).toBe('quelque.chose.de.neuf');
  });

  it('tolère des métadonnées absentes ou mal typées', () => {
    expect(describeEvent(AUDIT_EVENTS.SERVER_COMMAND, {})).toBe('A exécuté dans la console.');
    expect(describeEvent(AUDIT_EVENTS.SERVER_POWER, { action: 42 })).toBe(
      'A changé l’état du serveur.',
    );
  });
});
