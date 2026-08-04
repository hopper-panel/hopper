import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { ApiError, api } from '../lib/api';

/**
 * Choix du mot de passe initial, depuis le lien reçu par courriel.
 *
 * Page publique : son visiteur n'a précisément pas encore de quoi se connecter.
 * Le jeton de l'URL tient lieu d'authentification, et ne vaut qu'une fois.
 */
export function PasswordSetupPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useMutation({
    mutationFn: () => api.post<void>('/api/auth/password-setup', { token, password }),
    onSuccess: () => {
      setDone(true);
      setFailure(null);
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Enregistrement impossible.'),
  });

  const mismatch = confirmation !== '' && password !== confirmation;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-semibold text-content">
          <span aria-hidden className="mr-2">
            🪣
          </span>
          Hopper
        </h1>

        <Card>
          {token === '' ? (
            <Alert tone="danger">
              Ce lien est incomplet. Ouvrez-le depuis le courriel reçu, sans le recopier à la main.
            </Alert>
          ) : done ? (
            <>
              <Alert tone="info">
                Mot de passe enregistré. Vous pouvez maintenant vous connecter.
              </Alert>

              <div className="mt-4 flex justify-end">
                <a href="/">
                  <Button variant="primary">Aller à la connexion</Button>
                </a>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
                Choisissez votre mot de passe
              </h2>
              <p className="mb-4 text-sm text-content-muted">
                Ce lien ne fonctionne qu’une fois. Il protège l’accès à vos serveurs comme au SFTP.
              </p>

              {failure ? (
                <div className="mb-4">
                  <Alert tone="danger">{failure}</Alert>
                </div>
              ) : null}

              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit.mutate();
                }}
              >
                <Field label="Mot de passe" hint="Douze caractères au minimum.">
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    autoFocus
                  />
                </Field>

                <Field
                  label="Confirmation"
                  error={mismatch ? 'Les deux saisies diffèrent.' : undefined}
                >
                  <Input
                    type="password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="new-password"
                  />
                </Field>

                <Button
                  type="submit"
                  variant="primary"
                  disabled={submit.isPending || mismatch || password === ''}
                >
                  {submit.isPending ? 'Enregistrement…' : 'Enregistrer'}
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
