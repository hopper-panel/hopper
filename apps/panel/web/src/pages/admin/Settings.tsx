import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { LOCALES, LOCALE_NAMES, useTranslation } from '../../i18n';
import { ApiError, api } from '../../lib/api';
import { cx } from '../../lib/cx';

interface Settings {
  panelName: string;
  twoFactorRequirement: 'none' | 'admins' | 'all';
  defaultLocale: (typeof LOCALES)[number];
  mailEnabled: boolean;
  mailHost: string;
  mailPort: number;
  mailEncryption: 'none' | 'tls' | 'starttls';
  mailUsername: string;
  mailPassword: string;
  mailPasswordSet: boolean;
  mailFromAddress: string;
  mailFromName: string;
  nodeTimeoutMs: number;
  activityRetentionDays: number;
}

type Tab = 'general' | 'mail' | 'advanced';

const TABS: {
  id: Tab;
  label: 'adminSettings.tabGeneral' | 'adminSettings.tabMail' | 'adminSettings.tabAdvanced';
}[] = [
  { id: 'general', label: 'adminSettings.tabGeneral' },
  { id: 'mail', label: 'adminSettings.tabMail' },
  { id: 'advanced', label: 'adminSettings.tabAdvanced' },
];

const ENCRYPTIONS: { value: Settings['mailEncryption']; label: string }[] = [
  { value: 'starttls', label: 'STARTTLS (587)' },
  { value: 'tls', label: 'TLS (465)' },
  { value: 'none', label: 'None' },
];

/**
 * Instance settings.
 *
 * Three tabs, because they answer three different questions: how the panel
 * presents itself, how it sends mail, how it behaves. A single screen of twenty
 * fields reads badly and is filled in worse.
 *
 * What lives in `.env` — public URL, application secret, database — is not
 * here: those values underpin the encryption of everything else, and making
 * them editable from a form would hang the integrity of the instance on a
 * click.
 */
export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Settings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testAddress, setTestAddress] = useState('');

  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<{ settings: Settings }>('/api/admin/settings'),
  });

  const current = draft ?? settings.data?.settings ?? null;

  const patch = (values: Partial<Settings>): void => {
    if (current) {
      setDraft({ ...current, ...values });
    }
  };

  const save = useMutation({
    mutationFn: (values: Settings) =>
      api.patch<Settings>('/api/admin/settings', {
        panelName: values.panelName,
        twoFactorRequirement: values.twoFactorRequirement,
        defaultLocale: values.defaultLocale,
        mailEnabled: values.mailEnabled,
        mailHost: values.mailHost,
        mailPort: Number(values.mailPort) || 587,
        mailEncryption: values.mailEncryption,
        mailUsername: values.mailUsername,
        // Empty means unchanged: the server never returns the password, and
        // overwriting it with an empty string would wipe it on every save.
        mailPassword: values.mailPassword,
        mailFromAddress: values.mailFromAddress,
        mailFromName: values.mailFromName,
        nodeTimeoutMs: Number(values.nodeTimeoutMs) || 5000,
        activityRetentionDays: Number(values.activityRetentionDays) || 0,
      }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      setNotice(t('adminSettings.saved'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      // The panel name shows in the top bar: the session must reload it, or
      // the old name stays until the next full refresh.
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
    },
  });

  const test = useMutation({
    mutationFn: () => api.post<void>('/api/admin/settings/mail/test', { to: testAddress.trim() }),
    onSuccess: () => {
      setFailure(null);
      setNotice(t('adminSettings.testSent', { address: testAddress }));
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : t('common.operationFailed'));
    },
  });

  if (settings.isLoading || !current) {
    return <Spinner label={t('common.loading')} />;
  }

  return (
    <>
      <PageHeader
        title={t('adminSettings.title')}
        description={t('adminSettings.subtitle')}
        action={
          <Button
            variant="primary"
            disabled={save.isPending || draft === null}
            onClick={() => save.mutate(current)}
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        }
      />

      <nav
        className="mb-4 flex gap-1 border-b border-border-subtle"
        aria-label={t('common.sections')}
      >
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cx(
              '-mb-px border-b-2 px-4 py-2 text-sm transition-colors',
              tab === entry.id
                ? 'border-accent text-content'
                : 'border-transparent text-content-muted hover:text-content',
            )}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>

      {failure ? (
        <div className="mb-4">
          <Alert tone="danger">{failure}</Alert>
        </div>
      ) : null}

      {notice && !failure ? (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      ) : null}

      {draft !== null ? (
        <div className="mb-4">
          <Alert tone="info">{t('adminSettings.unsaved')}</Alert>
        </div>
      ) : null}

      {tab === 'general' ? (
        <Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field label={t('adminSettings.panelName')} hint={t('adminSettings.panelNameHint')}>
              <Input
                value={current.panelName}
                onChange={(event) => patch({ panelName: event.target.value })}
              />
            </Field>

            <div>
              <p className="mb-1.5 text-sm font-medium text-content">
                {t('adminSettings.defaultLanguage')}
              </p>

              <div className="flex flex-wrap gap-2">
                {LOCALES.map((locale) => (
                  <Button
                    key={locale}
                    lang={locale}
                    variant={current.defaultLocale === locale ? 'primary' : 'secondary'}
                    onClick={() => patch({ defaultLocale: locale })}
                  >
                    {LOCALE_NAMES[locale]}
                  </Button>
                ))}
              </div>

              <p className="mt-1.5 text-xs text-content-muted">
                {t('adminSettings.defaultLanguageHint')}
              </p>
            </div>

            <div className="lg:col-span-2">
              <p className="mb-1.5 text-sm font-medium text-content">
                {t('adminSettings.twoFactor')}
              </p>

              <div className="flex flex-wrap gap-2">
                {(['none', 'admins', 'all'] as const).map((option) => (
                  <Button
                    key={option}
                    variant={current.twoFactorRequirement === option ? 'primary' : 'secondary'}
                    onClick={() => patch({ twoFactorRequirement: option })}
                  >
                    {t(
                      option === 'none'
                        ? 'adminSettings.twoFactorNone'
                        : option === 'admins'
                          ? 'adminSettings.twoFactorAdmins'
                          : 'adminSettings.twoFactorAll',
                    )}
                  </Button>
                ))}
              </div>

              <p className="mt-1.5 text-xs text-content-muted">
                {t('adminSettings.twoFactorHint')}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === 'mail' ? (
        <div className="flex flex-col gap-4">
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-content">
                  {t('adminSettings.smtpTitle')}
                </h2>
                <p className="mt-1 text-sm text-content-muted">{t('adminSettings.smtpIntro')}</p>
              </div>

              <Button
                variant={current.mailEnabled ? 'primary' : 'secondary'}
                onClick={() => patch({ mailEnabled: !current.mailEnabled })}
              >
                {t(current.mailEnabled ? 'adminSettings.mailOn' : 'adminSettings.mailOff')}
              </Button>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Field label={t('adminSettings.mailHost')}>
                  <Input
                    value={current.mailHost}
                    onChange={(event) => patch({ mailHost: event.target.value })}
                    placeholder="smtp.exemple.fr"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label={t('adminSettings.mailPort')}>
                <Input
                  value={String(current.mailPort)}
                  onChange={(event) => patch({ mailPort: Number(event.target.value) })}
                  className="font-mono"
                  inputMode="numeric"
                />
              </Field>

              <div>
                <p className="mb-1.5 text-sm font-medium text-content">
                  {t('adminSettings.mailEncryption')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {ENCRYPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      variant={current.mailEncryption === option.value ? 'primary' : 'secondary'}
                      onClick={() => patch({ mailEncryption: option.value })}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>

              <Field
                label={t('adminSettings.mailUsername')}
                hint={t('adminSettings.mailUsernameHint')}
              >
                <Input
                  value={current.mailUsername}
                  onChange={(event) => patch({ mailUsername: event.target.value })}
                  className="font-mono"
                />
              </Field>

              <Field
                label={t('adminSettings.mailPassword')}
                hint={t(
                  current.mailPasswordSet
                    ? 'adminSettings.mailPasswordKept'
                    : 'adminSettings.mailPasswordNew',
                )}
              >
                <Input
                  type="password"
                  value={current.mailPassword}
                  onChange={(event) => patch({ mailPassword: event.target.value })}
                  placeholder={current.mailPasswordSet ? '••••••••' : ''}
                />
              </Field>

              <div className="lg:col-span-2">
                <Field label={t('adminSettings.mailFrom')}>
                  <Input
                    value={current.mailFromAddress}
                    onChange={(event) => patch({ mailFromAddress: event.target.value })}
                    placeholder="hopper@exemple.fr"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label={t('adminSettings.mailFromName')}>
                <Input
                  value={current.mailFromName}
                  onChange={(event) => patch({ mailFromName: event.target.value })}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
              {t('adminSettings.testTitle')}
            </h2>
            <p className="mb-4 text-sm text-content-muted">{t('adminSettings.testIntro')}</p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Field label={t('adminSettings.testRecipient')}>
                  <Input
                    value={testAddress}
                    onChange={(event) => setTestAddress(event.target.value)}
                    placeholder="you@example.com"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Button
                onClick={() => test.mutate()}
                disabled={test.isPending || testAddress.trim() === ''}
              >
                {test.isPending ? t('adminSettings.testSending') : t('adminSettings.testSend')}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'advanced' ? (
        <Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field label={t('adminSettings.nodeTimeout')} hint={t('adminSettings.nodeTimeoutHint')}>
              <Input
                value={String(current.nodeTimeoutMs)}
                onChange={(event) => patch({ nodeTimeoutMs: Number(event.target.value) })}
                className="font-mono"
                inputMode="numeric"
              />
            </Field>

            <Field label={t('adminSettings.retention')} hint={t('adminSettings.retentionHint')}>
              <Input
                value={String(current.activityRetentionDays)}
                onChange={(event) => patch({ activityRetentionDays: Number(event.target.value) })}
                className="font-mono"
                inputMode="numeric"
              />
            </Field>
          </div>

          <div className="mt-5">
            <Alert tone="info">{t('adminSettings.envNote')}</Alert>
          </div>
        </Card>
      ) : null}

      <p className="mt-4 text-xs text-content-subtle">
        <Badge tone={current.mailEnabled ? 'online' : 'offline'}>
          {t(current.mailEnabled ? 'adminSettings.mailOn' : 'adminSettings.mailOff')}
        </Badge>
      </p>
    </>
  );
}
