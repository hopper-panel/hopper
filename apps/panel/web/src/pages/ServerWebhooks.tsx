import { PERMISSIONS } from '@hopper/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CopyButton } from '../components/CopyButton';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useServerContext } from '../lib/server-context';

/**
 * Événements souscriptibles.
 *
 * Recopiés côté interface plutôt que lus depuis l'API : leurs libellés doivent
 * être traduits, et une liste rendue par le serveur obligerait à faire voyager
 * du texte d'interface dans une réponse JSON.
 */
const EVENTS: { value: string; label: string; description: string }[] = [
  { value: 'server.started', label: 'Serveur démarré', description: 'Le serveur accepte les joueurs.' },
  { value: 'server.stopped', label: 'Serveur arrêté', description: 'Arrêt demandé depuis le panel ou la console.' },
  {
    value: 'server.crashed',
    label: 'Serveur arrêté seul',
    description: 'Plantage, ou arrêt par le noyau faute de mémoire.',
  },
  { value: 'backup.completed', label: 'Sauvegarde terminée', description: 'L’archive est prête.' },
  { value: 'backup.failed', label: 'Sauvegarde échouée', description: 'L’archive n’a pas pu être écrite.' },
  { value: 'install.completed', label: 'Installation terminée', description: 'Le serveur est prêt à démarrer.' },
  { value: 'install.failed', label: 'Installation échouée', description: 'Le script d’installation a échoué.' },
];

interface Webhook {
  uuid: string;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  failureCount: number;
}

const EMPTY = { url: '', description: '', events: ['server.crashed'] as string[] };

export function ServerWebhooksPage() {
  const { server, can } = useServerContext();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<typeof EMPTY | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ uuid: string; value: string } | null>(null);

  const webhooks = useQuery({
    queryKey: ['server', server.uuid, 'webhooks'],
    queryFn: () => api.get<{ data: Webhook[] }>(`/api/servers/${server.uuid}/webhooks`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.uuid, 'webhooks'] });
  };

  const fail = (error: unknown): void => {
    setNotice(null);
    setFailure(error instanceof ApiError ? error.message : 'Opération impossible.');
  };

  const create = useMutation({
    mutationFn: (input: typeof EMPTY) =>
      api.post<Webhook>(`/api/servers/${server.uuid}/webhooks`, {
        url: input.url.trim(),
        description: input.description.trim(),
        events: input.events,
      }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      setNotice('Notification enregistrée. Envoyez un message de test pour la vérifier.');
      refresh();
    },
    onError: fail,
  });

  const toggle = useMutation({
    mutationFn: ({ uuid, active }: { uuid: string; active: boolean }) =>
      api.patch<Webhook>(`/api/servers/${server.uuid}/webhooks/${uuid}`, { active }),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: fail,
  });

  const test = useMutation({
    mutationFn: (uuid: string) =>
      api.post<{ delivered: boolean; status: number | null; error: string | null }>(
        `/api/servers/${server.uuid}/webhooks/${uuid}/test`,
      ),
    onSuccess: (result) => {
      setFailure(result.delivered ? null : (result.error ?? 'Le destinataire n’a pas répondu.'));
      setNotice(result.delivered ? 'Message de test remis au destinataire.' : null);
      refresh();
    },
    onError: fail,
  });

  const reveal = useMutation({
    mutationFn: (uuid: string) =>
      api
        .get<{ secret: string }>(`/api/servers/${server.uuid}/webhooks/${uuid}/secret`)
        .then((response) => ({ uuid, value: response.secret })),
    onSuccess: setSecret,
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/servers/${server.uuid}/webhooks/${uuid}`),
    onSuccess: () => {
      setFailure(null);
      setNotice(null);
      refresh();
    },
    onError: fail,
  });

  if (webhooks.isLoading) {
    return <Spinner label="Chargement des notifications…" />;
  }

  const list = webhooks.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Adresses prévenues des événements de ce serveur. Une adresse Discord reçoit un message mis en forme."
        action={
          can(PERMISSIONS.WEBHOOK_CREATE) ? (
            <Button variant="primary" onClick={() => setDraft({ ...EMPTY })}>
              Ajouter une adresse
            </Button>
          ) : null
        }
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

      {list.length === 0 ? (
        <EmptyState
          title="Aucune notification"
          description="Collez l’adresse d’un webhook Discord pour être prévenu quand ce serveur s’arrête tout seul."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((webhook) => (
            <Card key={webhook.uuid}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm text-content">
                      {redact(webhook.url)}
                    </span>
                    {webhook.active ? (
                      <Badge tone="online">active</Badge>
                    ) : (
                      <Badge tone="danger">en pause</Badge>
                    )}
                  </div>

                  {webhook.description ? (
                    <p className="mt-1 text-sm text-content-muted">{webhook.description}</p>
                  ) : null}

                  <p className="mt-1 text-xs text-content-subtle">
                    {webhook.events.map(labelOf).join(' · ')}
                  </p>

                  <p className="mt-1 text-xs text-content-subtle">
                    {webhook.lastAttemptAt === null
                      ? 'jamais appelée'
                      : webhook.lastError
                        ? `dernier envoi en échec — ${webhook.lastError}`
                        : `dernier envoi réussi le ${formatDate(webhook.lastSuccessAt)}`}
                    {webhook.failureCount > 0 ? ` · ${webhook.failureCount} échec(s) d’affilée` : null}
                  </p>

                  {secret?.uuid === webhook.uuid ? (
                    <p className="mt-2 flex items-center gap-2 break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-content">
                      {secret.value}
                      <CopyButton value={secret.value} />
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {can(PERMISSIONS.WEBHOOK_UPDATE) ? (
                    <>
                      <Button onClick={() => test.mutate(webhook.uuid)} disabled={test.isPending}>
                        Tester
                      </Button>
                      <Button onClick={() => reveal.mutate(webhook.uuid)} disabled={reveal.isPending}>
                        Secret
                      </Button>
                      <Button
                        onClick={() =>
                          toggle.mutate({ uuid: webhook.uuid, active: !webhook.active })
                        }
                        disabled={toggle.isPending}
                      >
                        {webhook.active ? 'Mettre en pause' : 'Réactiver'}
                      </Button>
                    </>
                  ) : null}

                  {can(PERMISSIONS.WEBHOOK_DELETE) ? (
                    <Button
                      variant="danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm('Supprimer cette notification ?')) {
                          remove.mutate(webhook.uuid);
                        }
                      }}
                    >
                      Supprimer
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={draft !== null}
        title="Ajouter une notification"
        onClose={() => setDraft(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Annuler
            </Button>
            <Button
              variant="primary"
              disabled={create.isPending || !draft?.url.trim() || draft.events.length === 0}
              onClick={() => draft && create.mutate(draft)}
            >
              {create.isPending ? 'Vérification…' : 'Ajouter'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-5">
            <Field
              label="Adresse"
              hint="Le webhook d’un salon Discord, ou n’importe quelle adresse qui accepte une requête POST."
            >
              <Input
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://discord.com/api/webhooks/…"
                className="font-mono"
              />
            </Field>

            <Field label="Description" hint="Pour vous y retrouver quand il y en aura plusieurs.">
              <Input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="Salon #alertes du staff"
              />
            </Field>

            <div>
              <p className="mb-2 text-sm font-medium text-content">Événements</p>

              <div className="flex flex-col gap-1">
                {EVENTS.map((event) => {
                  const checked = draft.events.includes(event.value);

                  return (
                    <label
                      key={event.value}
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        className="mt-1"
                        onChange={() =>
                          setDraft({
                            ...draft,
                            events: checked
                              ? draft.events.filter((entry) => entry !== event.value)
                              : [...draft.events, event.value],
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-content">{event.label}</span>
                        <span className="block text-xs text-content-muted">{event.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Le panel émettra une requête vers cette adresse : le dire
                explicitement, parce que c'est ce qui justifie le refus des
                adresses internes. */}
            <Alert tone="info">
              L’adresse est vérifiée avant enregistrement : le panel refuse celles qui mènent à un
              réseau interne. Chaque envoi est signé, et le secret de signature se consulte ensuite.
            </Alert>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function labelOf(value: string): string {
  return EVENTS.find((event) => event.value === value)?.label ?? value;
}

/**
 * Masque la partie secrète d'une adresse de webhook.
 *
 * L'URL d'un webhook Discord **est** son mot de passe : quiconque la lit peut
 * écrire dans le salon. L'afficher en entier dans une page qu'on montre
 * volontiers à son staff la donnerait à qui regarde par-dessus l'épaule.
 */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.length <= 1) {
      return `${parsed.origin}/${segments.join('/')}`;
    }

    return `${parsed.origin}/${segments.slice(0, -1).join('/')}/••••`;
  } catch {
    return url;
  }
}
