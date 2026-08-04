import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { useTranslation } from '../i18n';
import { ApiError, api } from '../lib/api';

/**
 * Initial password choice, from the link received by mail.
 *
 * Public by necessity: its visitor has nothing to sign in with yet. The token
 * in the URL stands in for authentication, and works once.
 */
export function PasswordSetupPage() {
  const { t } = useTranslation();
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
            <Alert tone="danger">{t('setup.incomplete')}</Alert>
          ) : done ? (
            <>
              <Alert tone="info">{t('setup.done')}</Alert>

              <div className="mt-4 flex justify-end">
                <a href="/">
                  <Button variant="primary">{t('setup.goToLogin')}</Button>
                </a>
              </div>
            </>
          ) : (
            <>
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
                {t('setup.title')}
              </h2>
              <p className="mb-4 text-sm text-content-muted">{t('setup.intro')}</p>

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
                <Field label={t('account.newPassword')} hint={t('account.passwordHint')}>
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    autoFocus
                  />
                </Field>

                <Field
                  label={t('account.confirmation')}
                  error={mismatch ? t('account.mismatch') : undefined}
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
                  {submit.isPending ? t('common.saving') : t('common.save')}
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
