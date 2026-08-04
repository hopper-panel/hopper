import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Button, Card, Field, Input } from '../components/ui';

/**
 * Sign-in page.
 *
 * Public, so it reads the instance name from the branding endpoint rather than
 * from the session: there is none yet.
 */
export function LoginPage() {
  const { login } = useAuth();
  const { t } = useTranslation();

  const branding = useQuery({
    queryKey: ['panel', 'branding'],
    queryFn: () => api.get<{ name: string }>('/api/panel'),
  });

  const panelName = branding.data?.name ?? 'Hopper';

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

      // The API asks for the second factor only once the password checks out:
      // on bascule sur le champ de code sans redemander les identifiants.
      if (result.status === 'two-factor-required') {
        setNeedsTotp(true);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('login.failed'));
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
          <h1 className="mt-3 text-2xl font-semibold text-content">{panelName}</h1>
          <p className="mt-1 text-sm text-content-muted">
            {needsTotp ? t('login.totpTitle') : t('login.title')}
          </p>
        </div>

        <Card>
          <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
            {error ? <Alert>{error}</Alert> : null}

            {needsTotp ? (
              <Field label={t('login.totpTitle')} hint={t('login.totpHint')}>
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
                <Field label={t('login.identifier')}>
                  <Input
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </Field>

                <Field label={t('login.password')}>
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
              {submitting ? t('login.submitting') : t('login.submit')}
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
