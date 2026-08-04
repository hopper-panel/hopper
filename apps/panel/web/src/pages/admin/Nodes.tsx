import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { ApiError, api, type NodeSummary, type Paginated } from '../../lib/api';
import { formatBytes } from '../../lib/format';

const GIB = 1024 ** 3;

export function AdminNodesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [configuration, setConfiguration] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => api.get<Paginated<NodeSummary>>('/api/admin/nodes'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ node: NodeSummary; configuration: string }>('/api/admin/nodes', body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
      setCreating(false);
      // Le secret n'existe qu'ici : il n'est stocké que chiffré et l'API ne le
      // renverra jamais une seconde fois.
      setConfiguration(result.configuration);
    },
  });

  if (isLoading) {
    return <Spinner />;
  }

  const nodes = data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Nodes"
        description="Les machines qui exécutent les serveurs."
        action={
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Annuler' : 'Ajouter un node'}
          </Button>
        }
      />

      {configuration ? (
        <DaemonConfiguration value={configuration} onDismiss={() => setConfiguration(null)} />
      ) : null}

      {creating ? (
        <CreateNodeForm
          onSubmit={(body) => createMutation.mutate(body)}
          pending={createMutation.isPending}
          error={createMutation.error}
        />
      ) : null}

      {nodes.length === 0 ? (
        <EmptyState
          title="Aucun node"
          description="Un node est une machine sur laquelle tourne hopperd. Ajoutez-en un pour pouvoir créer des serveurs."
        />
      ) : (
        <div className="space-y-3">
          {nodes.map((node) => (
            <NodeRow key={node.uuid} node={node} />
          ))}
        </div>
      )}
    </>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  return (
    <Link to={`/admin/nodes/${node.uuid}`} className="block">
      <Card className="transition-colors hover:border-accent/50">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-content">{node.name}</p>
              {node.maintenance ? <Badge tone="warn">maintenance</Badge> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-content-muted">
              {node.scheme}://{node.fqdn}:{node.port}
            </p>
          </div>

          <dl className="flex gap-6 text-xs">
            <div>
              <dt className="text-content-muted">Serveurs</dt>
              <dd className="mt-0.5 text-content">{node.serverCount}</dd>
            </div>
            <div>
              <dt className="text-content-muted">Ports</dt>
              <dd className="mt-0.5 text-content">{node.allocationCount}</dd>
            </div>
            <div>
              <dt className="text-content-muted">Mémoire</dt>
              <dd className="mt-0.5 text-content">{formatBytes(node.memoryBytes)}</dd>
            </div>
            <div>
              <dt className="text-content-muted">Disque</dt>
              <dd className="mt-0.5 text-content">{formatBytes(node.diskBytes)}</dd>
            </div>
          </dl>
        </div>
      </Card>
    </Link>
  );
}

function CreateNodeForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const [form, setForm] = useState({
    name: '',
    fqdn: '',
    scheme: 'https',
    port: 8443,
    memoryGib: 32,
    diskGib: 200,
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit({
      name: form.name,
      fqdn: form.fqdn,
      scheme: form.scheme,
      port: Number(form.port),
      memoryBytes: Math.round(form.memoryGib * GIB),
      diskBytes: Math.round(form.diskGib * GIB),
    });
  }

  return (
    <Card className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="node-paris-1"
              required
            />
          </Field>

          <Field
            label="FQDN"
            hint="Doit résoudre depuis le navigateur des utilisateurs : la console s'y connecte directement."
          >
            <Input
              value={form.fqdn}
              onChange={(event) => setForm({ ...form, fqdn: event.target.value })}
              placeholder="node1.example.com"
              required
            />
          </Field>

          <Field label="Port du daemon">
            <Input
              type="number"
              value={form.port}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
              min={1}
              max={65535}
              required
            />
          </Field>

          <Field label="Schéma" hint="HTTPS obligatoire dès que le panel est en HTTPS.">
            <select
              value={form.scheme}
              onChange={(event) => setForm({ ...form, scheme: event.target.value })}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
            >
              <option value="https">https</option>
              <option value="http">http</option>
            </select>
          </Field>

          <Field label="Mémoire (Gio)" hint="0 pour ne pas comptabiliser la capacité.">
            <Input
              type="number"
              value={form.memoryGib}
              onChange={(event) => setForm({ ...form, memoryGib: Number(event.target.value) })}
              min={0}
              required
            />
          </Field>

          <Field label="Disque (Gio)">
            <Input
              type="number"
              value={form.diskGib}
              onChange={(event) => setForm({ ...form, diskGib: Number(event.target.value) })}
              min={0}
              required
            />
          </Field>
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Création…' : 'Créer le node'}
        </Button>
      </form>
    </Card>
  );
}

function DaemonConfiguration({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Card className="mb-6 border-accent/40">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-content">Configuration du daemon</h2>
          <p className="mt-1 text-sm text-content-muted">
            À placer dans <code className="text-content">/etc/hopper/daemon.yml</code> sur la
            machine, puis <code className="text-content">chmod 600</code> et redémarrage de hopperd.
          </p>
          <p className="mt-2 text-sm text-accent">
            Le secret n’est affiché qu’une seule fois. Le perdre impose une rotation du jeton.
          </p>
        </div>
        <Button variant="ghost" onClick={onDismiss}>
          Fermer
        </Button>
      </div>

      <pre className="mt-4 max-h-80 overflow-auto rounded-lg border border-border-subtle bg-surface p-4 text-xs text-content">
        {value}
      </pre>

      <Button
        className="mt-3"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copié' : 'Copier'}
      </Button>
    </Card>
  );
}
