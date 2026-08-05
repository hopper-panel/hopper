import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../i18n';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { authenticateWithPasskey, passkeysSupported, wasCancelled } from '../lib/passkeys';
import { Alert, Button, Card, Field, Input } from '../components/ui';

/**
 * Sign-in page.
 *
 * Public, so it reads the instance name from the branding endpoint rather than
 * from the session: there is none yet.
 */
export function LoginPage() {
  const { login, adopt } = useAuth();
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
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const canUsePasskeys = passkeysSupported();

  /**
   * No identifier is asked for first.
   *
   * The credential is discoverable: the authenticator knows which account it
   * belongs to and says so. Asking who they are before letting them prove it
   * would put back the step passkeys exist to remove — and would tell anyone
   * who asks whether a given address has an account here.
   */
  async function signInWithPasskey(): Promise<void> {
    setError(null);
    setPasskeyBusy(true);

    try {
      adopt(await authenticateWithPasskey());
    } catch (caught) {
      // Dismissing the browser's prompt is a choice, not a failure.
      if (!wasCancelled(caught)) {
        setError(caught instanceof ApiError ? caught.message : t('login.passkeyFailed'));
      }
    } finally {
      setPasskeyBusy(false);
    }
  }

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
      // switch to the code field without asking for the credentials again.
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
                {t('login.back')}
              </Button>
            ) : null}

            {/* Hidden during the code step: a passkey login is already
                two-factor, so offering it there would look like a way around
                the code rather than a different door. */}
            {canUsePasskeys && !needsTotp ? (
              <>
                <div className="flex items-center gap-3 text-xs text-content-subtle">
                  <span className="h-px flex-1 bg-border-subtle" />
                  {t('login.or')}
                  <span className="h-px flex-1 bg-border-subtle" />
                </div>

                <Button
                  type="button"
                  className="w-full"
                  disabled={passkeyBusy}
                  onClick={() => void signInWithPasskey()}
                >
                  {passkeyBusy ? t('login.passkeyWaiting') : t('login.passkey')}
                </Button>
              </>
            ) : null}
          </form>
        </Card>
      </div>
    </div>
  );
}
