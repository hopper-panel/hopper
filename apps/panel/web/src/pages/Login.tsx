import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await login({
        identifier,
        password,
        totpCode: totpCode.trim() || undefined,
      });

      // L'API ne réclame le second facteur qu'une fois le mot de passe validé :
      // on bascule sur le champ de code sans redemander les identifiants.
      if (result.status === 'two-factor-required') {
        setNeedsTotp(true);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Connexion impossible. Réessayez.');
      setTotpCode('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div aria-hidden className="text-4xl">
            🪣
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-content">Hopper Panel</h1>
          <p className="mt-1 text-sm text-content-muted">
            {needsTotp ? 'Saisissez votre code de vérification' : 'Connectez-vous pour continuer'}
          </p>
        </div>

        <Card>
          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}

            {needsTotp ? (
              <Field
                label="Code de vérification"
                hint="Code à 6 chiffres de votre application, ou un code de récupération."
              >
                <Input
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  autoComplete="one-time-code"
                  inputMode="text"
                  placeholder="123456"
                  autoFocus
                  required
                />
              </Field>
            ) : (
              <>
                <Field label="Adresse e-mail ou nom d'utilisateur">
                  <Input
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </Field>

                <Field label="Mot de passe">
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </Field>
              </>
            )}

            <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
              {submitting ? 'Connexion…' : 'Se connecter'}
            </Button>

            {needsTotp ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setNeedsTotp(false);
                  setTotpCode('');
                  setError(null);
                }}
              >
                Revenir en arrière
              </Button>
            ) : null}
          </form>
        </Card>
      </div>
    </div>
  );
}
