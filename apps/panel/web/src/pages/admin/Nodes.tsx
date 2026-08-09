import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FormDialog } from '../../components/FormDialog';
import { PageHeader } from '../../components/PageHeader';
import { Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { api, type NodeSummary, type Paginated } from '../../lib/api';
import { formatBytes } from '../../lib/format';

const GIB = 1024 ** 3;

export function AdminNodesPage() {
  const { t } = useTranslation();
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
      // The secret exists only here: it is stored encrypted and the API will
      // never return it a second time.
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
        title={t('adminNodes.title')}
        description={t('adminNodes.subtitle')}
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('adminNodes.add')}
          </Button>
        }
      />

      {configuration ? (
        <DaemonConfiguration value={configuration} onDismiss={() => setConfiguration(null)} />
      ) : null}

      {creating ? (
        <CreateNodeForm
          onClose={() => setCreating(false)}
          onSubmit={(body) => createMutation.mutate(body)}
          pending={createMutation.isPending}
          error={createMutation.error}
        />
      ) : null}

      {nodes.length === 0 ? (
        <EmptyState title={t('adminNodes.empty')} description={t('adminNodes.emptyHint')} />
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
  const { t } = useTranslation();
  return (
    <Link to={`/admin/nodes/${node.uuid}`} className="block">
      <Card className="transition-colors hover:border-accent/50">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-content">{node.name}</p>
              {node.maintenance ? <Badge tone="warn">{t('adminNodes.maintenance')}</Badge> : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-content-muted">
              {node.scheme}://{node.fqdn}:{node.port}
            </p>
          </div>

          <dl className="flex gap-6 text-xs">
            <div>
              <dt className="text-content-muted">{t('adminNodes.servers')}</dt>
              <dd className="mt-0.5 text-content">{node.serverCount}</dd>
            </div>
            <div>
              <dt className="text-content-muted">{t('adminNodes.ports')}</dt>
              <dd className="mt-0.5 text-content">{node.allocationCount}</dd>
            </div>
            <div>
              <dt className="text-content-muted">{t('console.memory')}</dt>
              <dd className="mt-0.5 text-content">{formatBytes(node.memoryBytes)}</dd>
            </div>
            <div>
              <dt className="text-content-muted">{t('console.disk')}</dt>
              <dd className="mt-0.5 text-content">{formatBytes(node.diskBytes)}</dd>
            </div>
          </dl>
        </div>
      </Card>
    </Link>
  );
}

function CreateNodeForm({
  onClose,
  onSubmit,
  pending,
  error,
}: {
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: '',
    fqdn: '',
    scheme: 'https',
    port: 8443,
    memoryGib: 32,
    diskGib: 200,
  });

  function submit(): void {
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
    <FormDialog
      title={t('adminNodes.add')}
      formId="create-node"
      onClose={onClose}
      onSubmit={submit}
      submit={t('adminNodes.create')}
      submitting={t('adminNodes.creating')}
      pending={pending}
      disabled={form.name.trim() === '' || form.fqdn.trim() === ''}
      error={error}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('adminNodes.name')}>
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="node-paris-1"
            required
          />
        </Field>

        <Field label={t('adminNodes.fqdn')} hint={t('adminNodes.fqdnHint')}>
          <Input
            value={form.fqdn}
            onChange={(event) => setForm({ ...form, fqdn: event.target.value })}
            placeholder="node1.example.com"
            required
          />
        </Field>

        <Field label={t('adminNodes.daemonPort')}>
          <Input
            type="number"
            value={form.port}
            onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
            min={1}
            max={65535}
            required
          />
        </Field>

        <Field label={t('adminNodes.scheme')} hint={t('adminNodes.schemeHint')}>
          <select
            value={form.scheme}
            onChange={(event) => setForm({ ...form, scheme: event.target.value })}
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
          >
            <option value="https">https</option>
            <option value="http">http</option>
          </select>
        </Field>

        <Field label={t('adminNodes.memory')} hint={t('adminNodes.capacityHint')}>
          <Input
            type="number"
            value={form.memoryGib}
            onChange={(event) => setForm({ ...form, memoryGib: Number(event.target.value) })}
            min={0}
            required
          />
        </Field>

        <Field label={t('adminNodes.disk')}>
          <Input
            type="number"
            value={form.diskGib}
            onChange={(event) => setForm({ ...form, diskGib: Number(event.target.value) })}
            min={0}
            required
          />
        </Field>
      </div>
    </FormDialog>
  );
}

function DaemonConfiguration({ value, onDismiss }: { value: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  return (
    <Card className="mb-6 border-accent/40">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium text-content">{t('adminNodes.configTitle')}</h2>
          <p className="mt-1 text-sm text-content-muted">{t('adminNodes.configSteps')}</p>
          <p className="mt-2 text-sm text-accent">{t('adminNodes.configNote')}</p>
        </div>
        <Button variant="ghost" onClick={onDismiss}>
          {t('common.close')}
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
        {copied ? t('adminNodes.copied') : t('adminNodes.copy')}
      </Button>
    </Card>
  );
}
