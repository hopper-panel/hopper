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
        title="Serveurs"
        description={`${data?.meta.total ?? 0} serveur(s) sur l'instance`}
        action={
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Annuler' : 'Créer un serveur'}
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
        <EmptyState
          title="Aucun serveur"
          description="Créez d'abord un node et allouez-lui des ports, puis créez un serveur."
        />
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
                <th className="px-5 py-3 font-medium">Serveur</th>
                <th className="px-5 py-3 font-medium">État</th>
                <th className="px-5 py-3 font-medium">Node</th>
                <th className="px-5 py-3 font-medium">Adresse</th>
                <th className="px-5 py-3 font-medium">Mémoire</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const status = describeStatus(server.status);
                return (
                  <tr key={server.uuid} className="border-b border-border-subtle/50 last:border-0">
                    <td className="px-5 py-3">
                      <Link to={`/server/${server.uuid}`} className="text-content hover:underline">
                        {server.name}
                      </Link>
                      <p className="text-xs text-content-muted">{server.template.name}</p>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={status.tone}>{status.label}</Badge>
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

  // Les ports libres dépendent du node : la requête n'a de sens qu'une fois
  // celui-ci choisi.
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
          <Field label="Nom du serveur">
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Survie"
              required
            />
          </Field>

          <Select
            label="Propriétaire"
            value={form.ownerUuid}
            onChange={(value) => setForm({ ...form, ownerUuid: value })}
            options={(users?.data ?? []).map((user) => ({
              value: user.uuid,
              label: `${user.username} (${user.email})`,
            }))}
          />

          <Select
            label="Node"
            value={form.nodeUuid}
            onChange={(value) => setForm({ ...form, nodeUuid: value, allocationId: '' })}
            options={(nodes?.data ?? []).map((node) => ({
              value: node.uuid,
              label: `${node.name}${node.maintenance ? ' (maintenance)' : ''}`,
            }))}
          />

          <Select
            label="Port"
            value={form.allocationId}
            onChange={(value) => setForm({ ...form, allocationId: value })}
            options={freeAllocations.map((allocation) => ({
              value: String(allocation.id),
              label: `${allocation.ip}:${allocation.port}`,
            }))}
            hint={
              form.nodeUuid === ''
                ? "Choisissez d'abord un node."
                : freeAllocations.length === 0
                  ? 'Aucun port libre sur ce node.'
                  : undefined
            }
          />

          <Select
            label="Template"
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
            <Field label="Mémoire (Gio)">
              <Input
                type="number"
                value={form.memoryGib}
                onChange={(event) => setForm({ ...form, memoryGib: Number(event.target.value) })}
                min={0}
                step={0.5}
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
        </div>

        {/* Seules les variables modifiables sont affichées : les autres entrent
            dans la commande de démarrage et l'API ignore toute valeur envoyée
            pour elles. */}
        {template && template.variables.some((variable) => variable.userEditable) ? (
          <div className="border-t border-border-subtle pt-4">
            <p className="mb-3 text-sm font-medium text-content">Options du template</p>
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
          {pending ? 'Création…' : 'Créer le serveur'}
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
  return (
    <Field label={label} hint={hint}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
      >
        <option value="">— choisir —</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
