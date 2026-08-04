import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiKeysCard } from '../components/ApiKeysCard';
import { LanguageCard } from '../components/LanguageCard';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';

/**
 * The signed-in user's own account.
 *
 * Password, two-factor and language. The email address is not here: only the
 * administration can change it today, and offering a field that would fail is
 * worse than offering none.
 */
export function AccountPage() {
  const { user } = useAuth();
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <PageHeader
        title={t('account.title')}
        description={user ? `${user.username} — ${user.email}` : undefined}
        action={user?.role === 'ADMIN' ? <Badge tone="warn">{t('account.admin')}</Badge> : null}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <PasswordCard />
        <TwoFactorCard />
      </div>

      <div className="mt-4 grid gap-4">
        <LanguageCard />
        <ApiKeysCard />
      </div>
    </div>
  );
}

function PasswordCard() {
  const { t } = useTranslation();
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
      setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
    },
  });

  // The confirmation is checked here rather than by the API: a typo need not
  // make a round trip, and the message is more precise.
  const mismatch = confirmation !== '' && next !== confirmation;

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
        {t('account.passwordTitle')}
      </h2>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {done ? (
        <div className="mb-4">
          <Alert tone="info">{t('account.passwordChanged')}</Alert>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Field label={t('account.currentPassword')}>
          <Input
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
          />
        </Field>

        <Field label={t('account.newPassword')} hint={t('account.passwordHint')}>
          <Input
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
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
      </div>

      <div className="mt-4 flex justify-end">
        <Button
          variant="primary"
          disabled={change.isPending || mismatch || current === '' || next === ''}
          onClick={() => change.mutate()}
        >
          {change.isPending ? t('common.saving') : t('account.changePassword')}
        </Button>
      </div>
    </Card>
  );
}

function TwoFactorCard() {
  const { t } = useTranslation();
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
      setFailure(error instanceof ApiError ? error.message : t('common.operationFailed')),
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
      setFailure(error instanceof ApiError ? error.message : t('account.codeRejected')),
  });

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
        {t('account.twoFactorTitle')}
      </h2>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {recovery ? (
        <>
          {/* Shown once: they are not kept in clear on the panel side, and
              there is no way to display them again. */}
          <Alert tone="info">{t('account.recoveryIntro')}</Alert>

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
          <p className="text-sm text-content-muted">{t('account.twoFactorSecretIntro')}</p>

          <code className="block break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
            {setup.secret}
          </code>

          <Field label={t('account.twoFactorCode')}>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              className="font-mono"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSetup(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending || code.length < 6}
            >
              {confirm.isPending ? t('common.saving') : t('account.twoFactorActivate')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-content-muted">{t('account.twoFactorIntro')}</p>

          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => begin.mutate()} disabled={begin.isPending}>
              {begin.isPending ? t('common.loading') : t('account.twoFactorEnable')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
