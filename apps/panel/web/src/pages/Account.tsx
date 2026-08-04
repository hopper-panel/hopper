import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiKeysCard } from '../components/ApiKeysCard';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Compte de l'utilisateur connecté.
 *
 * Mot de passe et double authentification. L'adresse de courriel n'y figure pas :
 * seule l'administration sait la changer aujourd'hui, et proposer un champ qui
 * échouerait serait pire que de ne rien proposer.
 */
export function AccountPage() {
  const { user } = useAuth();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <PageHeader
        title="Mon compte"
        description={user ? `${user.username} — ${user.email}` : undefined}
        action={user?.role === 'ADMIN' ? <Badge tone="warn">administrateur</Badge> : null}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <PasswordCard />
        <TwoFactorCard />
      </div>

      <div className="mt-4">
        <ApiKeysCard />
      </div>
    </div>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () =>
      api.post<void>('/api/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirmation('');
      setFailure(null);
      setDone(true);
    },
    onError: (error: unknown) => {
      setDone(false);
      setFailure(error instanceof ApiError ? error.message : 'Changement impossible.');
    },
  });

  // La confirmation est vérifiée ici et non par l'API : une faute de frappe
  // n'a pas à faire un aller-retour, et le message est plus précis.
  const mismatch = confirmation !== '' && next !== confirmation;

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
        Mot de passe
      </h2>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {done ? (
        <div className="mb-4">
          <Alert tone="info">
            Mot de passe changé. Vos autres sessions ont été fermées, et le SFTP utilise désormais
            ce nouveau mot de passe.
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Field label="Mot de passe actuel">
          <Input
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
          />
        </Field>

        <Field label="Nouveau mot de passe" hint="Douze caractères au minimum.">
          <Input
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
          />
        </Field>

        <Field label="Confirmation" error={mismatch ? 'Les deux saisies diffèrent.' : undefined}>
          <Input
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          disabled={change.isPending || mismatch || current === '' || next === ''}
          onClick={() => change.mutate()}
        >
          {change.isPending ? 'Changement…' : 'Changer le mot de passe'}
        </Button>
      </div>
    </Card>
  );
}

function TwoFactorCard() {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const begin = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup'),
    onSuccess: (data) => {
      setSetup(data);
      setFailure(null);
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Activation impossible.'),
  });

  const confirm = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', { code }),
    onSuccess: (data) => {
      setSetup(null);
      setCode('');
      setFailure(null);
      setRecovery(data.recoveryCodes);
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Code refusé.'),
  });

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
        Double authentification
      </h2>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {recovery ? (
        <>
          {/* Montrés une seule fois : ils ne sont pas conservés en clair côté
              panel, et il n'y a aucun moyen de les réafficher. */}
          <Alert tone="info">
            Notez ces codes de récupération : ils ne seront plus jamais affichés. Chacun ne sert
            qu’une fois, si vous perdez votre téléphone.
          </Alert>

          <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm text-content">
            {recovery.map((entry) => (
              <li key={entry} className="rounded bg-surface px-2 py-1">
                {entry}
              </li>
            ))}
          </ul>
        </>
      ) : setup ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-content-muted">
            Ajoutez ce secret dans votre application d’authentification, puis saisissez le code
            qu’elle affiche.
          </p>

          <code className="block break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
            {setup.secret}
          </code>

          <Field label="Code à six chiffres">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              className="font-mono"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSetup(null)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending || code.length < 6}
            >
              {confirm.isPending ? 'Vérification…' : 'Activer'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-content-muted">
            Un second facteur protège votre compte même si votre mot de passe fuite. Il protège
            aussi le SFTP, qui utilise les mêmes identifiants.
          </p>

          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => begin.mutate()} disabled={begin.isPending}>
              {begin.isPending ? 'Préparation…' : 'Activer la double authentification'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
