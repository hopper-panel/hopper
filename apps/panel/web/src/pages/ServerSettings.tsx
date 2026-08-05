import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useTranslation } from '../i18n';
import { useServerContext } from '../lib/server-context';

interface Settings {
  uuid: string;
  name: string;
  description: string;
  node: { name: string; fqdn: string };
  template: string;
  status: string;
  sftp: { address: string; username: string };
}

export function ServerSettingsPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can } = useServerContext();
  const { t } = useTranslation();

  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['server', uuid, 'settings'],
    queryFn: () => api.get<Settings>(`/api/servers/${uuid}/settings`),
    refetchOnWindowFocus: false,
  });

  const rename = useMutation({
    mutationFn: (body: { name: string; description: string }) =>
      api.patch<unknown>(`/api/servers/${uuid}`, body),
    onSuccess: () => {
      setFailure(null);
      setNotice(t('serverSettings.saved'));
      void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
      void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'settings'] });
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : t('serverSettings.saveFailed')),
  });

  const reinstall = useMutation({
    mutationFn: () => api.post<void>(`/api/servers/${uuid}/settings/reinstall`),
    onSuccess: () => {
      setFailure(null);
      setNotice(t('serverSettings.reinstallStarted'));
      void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : t('serverSettings.reinstallFailed')),
  });

  if (settings.isLoading || !settings.data) {
    return <Spinner label={t('common.loading')} />;
  }

  const data = settings.data;
  const currentName = name ?? data.name;
  const currentDescription = description ?? data.description;
  const dirty = currentName !== data.name || currentDescription !== data.description;

  return (
    <>
      <PageHeader title={t('serverSettings.title')} description={t('serverSettings.subtitle')} />

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

      <div className="grid gap-4 lg:grid-cols-2">
        {can('file.sftp') ? (
          <Card>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
              {t('serverSettings.sftpTitle')}
            </h2>

            <div className="flex flex-col gap-4">
              <Field label={t('serverSettings.sftpAddress')}>
                <Input value={data.sftp.address} readOnly className="font-mono" />
              </Field>

              <Field label={t('serverSettings.sftpUsername')}>
                <Input value={data.sftp.username} readOnly className="font-mono" />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-2 border-accent bg-surface px-3 py-2">
              <p className="text-xs text-content-muted">{t('serverSettings.sftpPasswordNote')}</p>
              {/* An `sftp://` link opens the configured client. No password
                  goes in it — a password in a URL ends up in history and logs. */}
              <a
                href={`${data.sftp.address.replace('sftp://', `sftp://${data.sftp.username}@`)}`}
                className="whitespace-nowrap text-sm font-medium text-accent hover:underline"
              >
                {t('serverSettings.sftpOpen')}
              </a>
            </div>
          </Card>
        ) : null}

        <Card>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
            {t('serverSettings.identityTitle')}
          </h2>

          <div className="flex flex-col gap-4">
            <Field label={t('serverSettings.name')}>
              <Input
                value={currentName}
                disabled={!can('settings.rename')}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field label={t('serverSettings.description')}>
              <textarea
                className="min-h-24 w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none disabled:opacity-60"
                value={currentDescription}
                disabled={!can('settings.rename')}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </div>

          {can('settings.rename') ? (
            <div className="mt-4 flex justify-end">
              <Button
                variant="primary"
                disabled={!dirty || rename.isPending || currentName.trim() === ''}
                onClick={() =>
                  rename.mutate({ name: currentName.trim(), description: currentDescription })
                }
              >
                {rename.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
            {t('serverSettings.technicalTitle')}
          </h2>

          <dl className="flex flex-col gap-3 text-sm">
            <Row label={t('serverSettings.node')} value={<Badge>{data.node.name}</Badge>} />
            <Row
              label={t('serverSettings.nodeAddress')}
              value={<span className="font-mono">{data.node.fqdn}</span>}
            />
            <Row label={t('serverSettings.template')} value={data.template} />
            <Row
              label={t('serverSettings.identifier')}
              value={
                <code className="rounded bg-surface px-2 py-1 font-mono text-xs">{data.uuid}</code>
              }
            />
          </dl>

          <p className="mt-3 text-xs text-content-muted">{t('serverSettings.identifierNote')}</p>
        </Card>

        {can('settings.reinstall') ? (
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content">
              {t('serverSettings.reinstallTitle')}
            </h2>

            <p className="text-sm text-content-muted">{t('serverSettings.reinstallWarning')}</p>

            <div className="mt-4 flex justify-end">
              <Button
                variant="danger"
                disabled={reinstall.isPending}
                onClick={() => {
                  // Confirmed by typing the server name: an "are you sure?"
                  // gets clicked through, and this action can erase files.
                  const typed = window.prompt(
                    t('serverSettings.reinstallPrompt', { name: data.name }),
                  );

                  if (typed?.trim() === data.name) {
                    reinstall.mutate();
                  } else if (typed !== null) {
                    setFailure(t('serverSettings.reinstallMismatch'));
                  }
                }}
              >
                {reinstall.isPending
                  ? t('serverSettings.reinstalling')
                  : t('serverSettings.reinstall')}
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <dt className="text-content-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-content">{value}</dd>
    </div>
  );
}
