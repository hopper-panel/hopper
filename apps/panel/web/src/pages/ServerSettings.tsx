import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
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
      setNotice('Enregistré.');
      void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
      void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'settings'] });
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Enregistrement impossible.'),
  });

  const reinstall = useMutation({
    mutationFn: () => api.post<void>(`/api/servers/${uuid}/settings/reinstall`),
    onSuccess: () => {
      setFailure(null);
      setNotice('Réinstallation lancée. Suivez son avancement dans la console.');
      void queryClient.invalidateQueries({ queryKey: ['server', uuid] });
    },
    onError: (error: unknown) =>
      setFailure(error instanceof ApiError ? error.message : 'Réinstallation impossible.'),
  });

  if (settings.isLoading || !settings.data) {
    return <Spinner label="Chargement des paramètres…" />;
  }

  const data = settings.data;
  const currentName = name ?? data.name;
  const currentDescription = description ?? data.description;
  const dirty = currentName !== data.name || currentDescription !== data.description;

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Accès SFTP, informations techniques et réinstallation."
      />

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
              Accès SFTP
            </h2>

            <div className="flex flex-col gap-4">
              <Field label="Adresse du serveur">
                <Input value={data.sftp.address} readOnly className="font-mono" />
              </Field>

              <Field label="Nom d’utilisateur">
                <Input value={data.sftp.username} readOnly className="font-mono" />
              </Field>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border-l-2 border-accent bg-surface px-3 py-2">
              <p className="text-xs text-content-muted">
                Le mot de passe SFTP est celui de votre compte sur ce panel. Il n’est jamais affiché
                ici.
              </p>
              {/* Lien `sftp://` : le système ouvre le client configuré. Aucun
                  mot de passe n'y figure — le mettre dans une URL le ferait
                  apparaître dans l'historique et les journaux. */}
              <a
                href={`${data.sftp.address.replace('sftp://', `sftp://${data.sftp.username}@`)}`}
                className="whitespace-nowrap text-sm font-medium text-accent hover:underline"
              >
                Ouvrir le SFTP
              </a>
            </div>
          </Card>
        ) : null}

        <Card>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
            Nom et description
          </h2>

          <div className="flex flex-col gap-4">
            <Field label="Nom du serveur">
              <Input
                value={currentName}
                disabled={!can('settings.rename')}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <Field label="Description">
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
                {rename.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content">
            Informations techniques
          </h2>

          <dl className="flex flex-col gap-3 text-sm">
            <Row label="Node" value={<Badge>{data.node.name}</Badge>} />
            <Row
              label="Adresse du node"
              value={<span className="font-mono">{data.node.fqdn}</span>}
            />
            <Row label="Template" value={data.template} />
            <Row
              label="Identifiant"
              value={
                <code className="rounded bg-surface px-2 py-1 font-mono text-xs">{data.uuid}</code>
              }
            />
          </dl>

          <p className="mt-3 text-xs text-content-muted">
            L’identifiant est ce qu’on vous demandera pour un diagnostic : il désigne ce serveur
            dans les journaux du node.
          </p>
        </Card>

        {can('settings.reinstall') ? (
          <Card>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-content">
              Réinstaller le serveur
            </h2>

            <p className="text-sm text-content-muted">
              Le serveur est arrêté, puis le script d’installation du template est rejoué. Selon le
              template, <strong>des fichiers peuvent être écrasés</strong> — sauvegardez avant de
              continuer.
            </p>

            <div className="mt-4 flex justify-end">
              <Button
                variant="danger"
                disabled={reinstall.isPending}
                onClick={() => {
                  // Confirmation par le nom du serveur : un « êtes-vous sûr ? »
                  // se valide sans lire, et cette action peut effacer des
                  // fichiers.
                  const typed = window.prompt(
                    `Pour confirmer la réinstallation, saisissez le nom du serveur : ${data.name}`,
                  );

                  if (typed?.trim() === data.name) {
                    reinstall.mutate();
                  } else if (typed !== null) {
                    setFailure('Le nom saisi ne correspond pas : réinstallation annulée.');
                  }
                }}
              >
                {reinstall.isPending ? 'Lancement…' : 'Réinstaller'}
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
