import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { cx } from '../../lib/cx';

interface Settings {
  panelName: string;
  twoFactorRequirement: 'none' | 'admins' | 'all';
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

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'Général' },
  { id: 'mail', label: 'Courriel' },
  { id: 'advanced', label: 'Avancé' },
];

const TWO_FACTOR: { value: Settings['twoFactorRequirement']; label: string }[] = [
  { value: 'none', label: 'Facultative' },
  { value: 'admins', label: 'Administrateurs' },
  { value: 'all', label: 'Tout le monde' },
];

const ENCRYPTIONS: { value: Settings['mailEncryption']; label: string }[] = [
  { value: 'starttls', label: 'STARTTLS (587)' },
  { value: 'tls', label: 'TLS implicite (465)' },
  { value: 'none', label: 'Aucun' },
];

/**
 * Paramètres de l'instance.
 *
 * Trois onglets, comme dans Pterodactyl, parce qu'ils répondent à trois
 * questions différentes : comment le panel se présente, comment il envoie ses
 * courriels, et comment il se comporte. Un seul écran de vingt champs se lit
 * mal et se remplit encore plus mal.
 *
 * Ce qui vit dans le `.env` — URL publique, secret d'application, base de
 * données — n'y figure pas : ces valeurs engagent le chiffrement de tout le
 * reste, et les rendre modifiables par un formulaire ferait dépendre
 * l'intégrité de l'instance d'un clic.
 */
export function AdminSettingsPage() {
  const queryClient = useQueryClient();
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
        mailEnabled: values.mailEnabled,
        mailHost: values.mailHost,
        mailPort: Number(values.mailPort) || 587,
        mailEncryption: values.mailEncryption,
        mailUsername: values.mailUsername,
        // Vide veut dire « inchangé » : le serveur ne renvoie jamais le mot de
        // passe, l'écraser avec une chaîne vide l'effacerait à chaque
        // enregistrement.
        mailPassword: values.mailPassword,
        mailFromAddress: values.mailFromAddress,
        mailFromName: values.mailFromName,
        nodeTimeoutMs: Number(values.nodeTimeoutMs) || 5000,
        activityRetentionDays: Number(values.activityRetentionDays) || 0,
      }),
    onSuccess: () => {
      setDraft(null);
      setFailure(null);
      setNotice('Paramètres enregistrés.');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      // Le nom du panel apparaît dans la barre supérieure : la session doit le
      // relire, sinon l'ancien nom reste affiché jusqu'au prochain rechargement.
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : 'Enregistrement impossible.');
    },
  });

  const test = useMutation({
    mutationFn: () => api.post<void>('/api/admin/settings/mail/test', { to: testAddress.trim() }),
    onSuccess: () => {
      setFailure(null);
      setNotice(`Message envoyé à ${testAddress}. S’il n’arrive pas, regardez les indésirables.`);
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : 'Envoi impossible.');
    },
  });

  if (settings.isLoading || !current) {
    return <Spinner label="Chargement des paramètres…" />;
  }

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Comment le panel se présente, envoie ses courriels et se comporte."
        action={
          <Button
            variant="primary"
            disabled={save.isPending || draft === null}
            onClick={() => save.mutate(current)}
          >
            {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        }
      />

      <nav className="mb-4 flex gap-1 border-b border-border-subtle" aria-label="Sections">
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
            {entry.label}
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
          <Alert tone="info">Modifications non enregistrées.</Alert>
        </div>
      ) : null}

      {tab === 'general' ? (
        <Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field
              label="Nom de l’instance"
              hint="Affiché dans l’interface et dans les courriels envoyés."
            >
              <Input
                value={current.panelName}
                onChange={(event) => patch({ panelName: event.target.value })}
              />
            </Field>

            <div>
              <p className="mb-1.5 text-sm font-medium text-content">Double authentification</p>

              <div className="flex flex-wrap gap-2">
                {TWO_FACTOR.map((option) => (
                  <Button
                    key={option.value}
                    variant={
                      current.twoFactorRequirement === option.value ? 'primary' : 'secondary'
                    }
                    onClick={() => patch({ twoFactorRequirement: option.value })}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>

              <p className="mt-1.5 text-xs text-content-muted">
                Les comptes concernés gardent l’accès à leur page « Mon compte » pour l’activer — on
                ne peut pas exiger un second facteur avant de laisser quelqu’un le configurer.
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
                  Serveur SMTP
                </h2>
                <p className="mt-1 text-sm text-content-muted">
                  Sans lui, la création d’un compte n’envoie rien : l’administrateur doit
                  transmettre lui-même un mot de passe.
                </p>
              </div>

              <Button
                variant={current.mailEnabled ? 'primary' : 'secondary'}
                onClick={() => patch({ mailEnabled: !current.mailEnabled })}
              >
                {current.mailEnabled ? 'Envoi activé' : 'Envoi désactivé'}
              </Button>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Field label="Hôte">
                  <Input
                    value={current.mailHost}
                    onChange={(event) => patch({ mailHost: event.target.value })}
                    placeholder="smtp.exemple.fr"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label="Port">
                <Input
                  value={String(current.mailPort)}
                  onChange={(event) => patch({ mailPort: Number(event.target.value) })}
                  className="font-mono"
                  inputMode="numeric"
                />
              </Field>

              <div>
                <p className="mb-1.5 text-sm font-medium text-content">Chiffrement</p>
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

              <Field label="Identifiant" hint="Vide pour un serveur sans authentification.">
                <Input
                  value={current.mailUsername}
                  onChange={(event) => patch({ mailUsername: event.target.value })}
                  className="font-mono"
                />
              </Field>

              <Field
                label="Mot de passe"
                hint={
                  current.mailPasswordSet
                    ? 'Enregistré. Laissez vide pour le conserver.'
                    : 'Stocké chiffré, jamais réaffiché.'
                }
              >
                <Input
                  type="password"
                  value={current.mailPassword}
                  onChange={(event) => patch({ mailPassword: event.target.value })}
                  placeholder={current.mailPasswordSet ? '••••••••' : ''}
                />
              </Field>

              <div className="lg:col-span-2">
                <Field label="Adresse d’expédition">
                  <Input
                    value={current.mailFromAddress}
                    onChange={(event) => patch({ mailFromAddress: event.target.value })}
                    placeholder="hopper@exemple.fr"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Field label="Nom de l’expéditeur">
                <Input
                  value={current.mailFromName}
                  onChange={(event) => patch({ mailFromName: event.target.value })}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
              Envoi de vérification
            </h2>
            <p className="mb-4 text-sm text-content-muted">
              Le test utilise les paramètres <strong>enregistrés</strong> : enregistrez avant de
              l’essayer.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Field label="Destinataire">
                  <Input
                    value={testAddress}
                    onChange={(event) => setTestAddress(event.target.value)}
                    placeholder="vous@exemple.fr"
                    className="font-mono"
                  />
                </Field>
              </div>

              <Button
                onClick={() => test.mutate()}
                disabled={test.isPending || testAddress.trim() === ''}
              >
                {test.isPending ? 'Envoi…' : 'Envoyer'}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'advanced' ? (
        <Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Field
              label="Délai d’attente des nodes (ms)"
              hint="Au-delà, un daemon est déclaré injoignable. Augmentez-le pour une machine lointaine."
            >
              <Input
                value={String(current.nodeTimeoutMs)}
                onChange={(event) => patch({ nodeTimeoutMs: Number(event.target.value) })}
                className="font-mono"
                inputMode="numeric"
              />
            </Field>

            <Field
              label="Rétention du journal d’activité (jours)"
              hint="0 conserve tout. Le journal dit qui a fait quoi : le purger est un choix, pas un réglage par défaut."
            >
              <Input
                value={String(current.activityRetentionDays)}
                onChange={(event) => patch({ activityRetentionDays: Number(event.target.value) })}
                className="font-mono"
                inputMode="numeric"
              />
            </Field>
          </div>

          <div className="mt-5">
            <Alert tone="info">
              L’URL publique, le secret d’application et l’accès à la base restent dans le fichier{' '}
              <code className="font-mono">.env</code>. Le secret chiffre les jetons de node et les
              mots de passe SQL : le changer par mégarde rendrait tout cela illisible.
            </Alert>
          </div>
        </Card>
      ) : null}

      <p className="mt-4 text-xs text-content-subtle">
        {current.mailEnabled ? (
          <Badge tone="online">courriel actif</Badge>
        ) : (
          <Badge>courriel inactif</Badge>
        )}
      </p>
    </>
  );
}
