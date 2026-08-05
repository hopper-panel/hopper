import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner } from '../../components/ui';
import {
  ApiError,
  api,
  type AllocationSummary,
  type NodeSummary,
  type Paginated,
  type ServerSummary,
  type UserSummary,
} from '../../lib/api';
import { useTranslation } from '../../i18n';
import { describeStatus, formatAddress, formatBytes } from '../../lib/format';

const GIB = 1024 ** 3;

interface TemplateSummary {
  uuid: string;
  name: string;
  group: { name: string };
  dockerImages: { name: string; image: string }[];
  variables: { name: string; envVariable: string; defaultValue: string; userEditable: boolean }[];
}

export function AdminServersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'servers'],
    queryFn: () => api.get<Paginated<ServerSummary>>('/api/admin/servers'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<ServerSummary>('/api/admin/servers', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      setCreating(false);
    },
  });

  if (isLoading) {
    return <Spinner />;
  }

  const servers = data?.data ?? [];

  return (
    <>
      <PageHeader
        title={t('adminServers.title')}
        description={t('adminServers.count', { count: data?.meta.total ?? 0 })}
        action={
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? t('common.cancel') : t('adminServers.create')}
          </Button>
        }
      />

      {creating ? (
        <CreateServerForm
          onSubmit={(body) => createMutation.mutate(body)}
          pending={createMutation.isPending}
          error={createMutation.error}
        />
      ) : null}

      {servers.length === 0 ? (
        <EmptyState title={t('adminServers.empty')} description={t('adminServers.emptyHint')} />
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
                <th className="px-5 py-3 font-medium">{t('adminServers.server')}</th>
                <th className="px-5 py-3 font-medium">{t('adminServers.state')}</th>
                <th className="px-5 py-3 font-medium">{t('adminServers.node')}</th>
                <th className="px-5 py-3 font-medium">{t('adminServers.address')}</th>
                <th className="px-5 py-3 font-medium">{t('adminServers.memory')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const status = describeStatus(server.status);
                return (
                  <tr key={server.uuid} className="border-b border-border-subtle/50 last:border-0">
                    <td className="px-5 py-3">
                      <Link
                        to={`/admin/servers/${server.uuid}`}
                        className="text-content hover:underline"
                      >
                        {server.name}
                      </Link>
                      <p className="text-xs text-content-muted">{server.template.name}</p>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={status.tone}>{t(status.key)}</Badge>
                    </td>
                    <td className="px-5 py-3 text-content-muted">{server.node.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-content-muted">
                      {formatAddress(server.primaryAllocation)}
                    </td>
                    <td className="px-5 py-3 text-content-muted">
                      {formatBytes(server.memoryBytes)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function CreateServerForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: '',
    ownerUuid: '',
    nodeUuid: '',
    templateUuid: '',
    allocationId: '',
    memoryGib: 4,
    diskGib: 10,
  });
  const [variables, setVariables] = useState<Record<string, string>>({});

  const { data: users } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<Paginated<UserSummary>>('/api/admin/users?perPage=100'),
  });

  const { data: nodes } = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => api.get<Paginated<NodeSummary>>('/api/admin/nodes?perPage=100'),
  });

  const { data: templates } = useQuery({
    queryKey: ['admin', 'templates'],
    queryFn: () => api.get<TemplateSummary[]>('/api/admin/templates'),
  });

  // Free ports depend on the node: the query only makes sense once one is
  // chosen.
  const { data: allocations } = useQuery({
    queryKey: ['admin', 'node', form.nodeUuid, 'allocations'],
    queryFn: () =>
      api.get<Paginated<AllocationSummary>>(
        `/api/admin/nodes/${form.nodeUuid}/allocations?perPage=100`,
      ),
    enabled: form.nodeUuid !== '',
  });

  const template = templates?.find((entry) => entry.uuid === form.templateUuid);
  const freeAllocations = allocations?.data.filter((entry) => entry.assignedTo === null) ?? [];

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit({
      name: form.name,
      ownerUuid: form.ownerUuid,
      nodeUuid: form.nodeUuid,
      templateUuid: form.templateUuid,
      allocationId: Number(form.allocationId),
      memoryBytes: Math.round(form.memoryGib * GIB),
      diskBytes: Math.round(form.diskGib * GIB),
      variables,
    });
  }

  return (
    <Card className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('adminServers.name')}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={t('adminServers.namePlaceholder')}
              required
            />
          </Field>

          <Select
            label={t('adminServers.owner')}
            value={form.ownerUuid}
            onChange={(value) => setForm({ ...form, ownerUuid: value })}
            options={(users?.data ?? []).map((user) => ({
              value: user.uuid,
              label: `${user.username} (${user.email})`,
            }))}
          />

          <Select
            label={t('adminServers.node')}
            value={form.nodeUuid}
            onChange={(value) => setForm({ ...form, nodeUuid: value, allocationId: '' })}
            options={(nodes?.data ?? []).map((node) => ({
              value: node.uuid,
              label: node.maintenance
                ? `${node.name} (${t('adminServers.maintenance')})`
                : node.name,
            }))}
          />

          <Select
            label={t('adminServers.port')}
            value={form.allocationId}
            onChange={(value) => setForm({ ...form, allocationId: value })}
            options={freeAllocations.map((allocation) => ({
              value: String(allocation.id),
              label: `${allocation.ip}:${allocation.port}`,
            }))}
            hint={
              form.nodeUuid === ''
                ? t('adminServers.chooseNode')
                : freeAllocations.length === 0
                  ? t('adminServers.noFreePort')
                  : undefined
            }
          />

          <Select
            label={t('adminServers.template')}
            value={form.templateUuid}
            onChange={(value) => {
              setForm({ ...form, templateUuid: value });
              const selected = templates?.find((entry) => entry.uuid === value);
              setVariables(
                Object.fromEntries(
                  (selected?.variables ?? [])
                    .filter((variable) => variable.userEditable)
                    .map((variable) => [variable.envVariable, variable.defaultValue]),
                ),
              );
            }}
            options={(templates ?? []).map((entry) => ({
              value: entry.uuid,
              label: `${entry.group.name} — ${entry.name}`,
            }))}
          />

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('adminServers.memoryGib')}>
              <Input
                type="number"
                value={form.memoryGib}
                onChange={(event) => setForm({ ...form, memoryGib: Number(event.target.value) })}
                min={0}
                step={0.5}
                required
              />
            </Field>
            <Field label={t('adminServers.diskGib')}>
              <Input
                type="number"
                value={form.diskGib}
                onChange={(event) => setForm({ ...form, diskGib: Number(event.target.value) })}
                min={0}
                required
              />
            </Field>
          </div>
        </div>

        {/* Only editable variables are shown: the others feed the startup
            command, and the API ignores any value sent for them. */}
        {template && template.variables.some((variable) => variable.userEditable) ? (
          <div className="border-t border-border-subtle pt-4">
            <p className="mb-3 text-sm font-medium text-content">
              {t('adminServers.templateOptions')}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {template.variables
                .filter((variable) => variable.userEditable)
                .map((variable) => (
                  <Field key={variable.envVariable} label={variable.name}>
                    <Input
                      value={variables[variable.envVariable] ?? variable.defaultValue}
                      onChange={(event) =>
                        setVariables({ ...variables, [variable.envVariable]: event.target.value })
                      }
                    />
                  </Field>
                ))}
            </div>
          </div>
        ) : null}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? t('common.saving') : t('adminServers.submit')}
        </Button>
      </form>
    </Card>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  const { t } = useTranslation();

  return (
    <Field label={label} hint={hint}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
      >
        <option value="">{t('adminServers.choose')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
