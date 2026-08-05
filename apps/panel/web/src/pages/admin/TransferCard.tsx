import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, Field, Spinner } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { ApiError, api } from '../../lib/api';

/**
 * Moving a server to another node.
 *
 * The plan is fetched as soon as a node is picked, before anything happens.
 * A transfer stops the server and moves gigabytes; what it will cost belongs
 * in front of the button, not in the log afterwards.
 */

interface NodeOption {
  uuid: string;
  name: string;
}

interface TransferPlan {
  fromNode: string;
  toNode: string;
  availableOnTarget: number;
  strandedDatabases: string[];
}

export function TransferCard({
  server,
  currentNode,
}: {
  server: { uuid: string; name: string };
  currentNode: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [target, setTarget] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const nodes = useQuery({
    queryKey: ['admin', 'nodes', 'all'],
    queryFn: () => api.get<{ data: NodeOption[] }>('/api/admin/nodes?perPage=100'),
  });

  const plan = useQuery({
    queryKey: ['admin', 'server', server.uuid, 'transfer', target],
    queryFn: () =>
      api.get<TransferPlan>(`/api/admin/servers/${server.uuid}/transfer?node=${target}`),
    enabled: target !== '',
  });

  const transfer = useMutation({
    mutationFn: () =>
      api.post<{ node: string }>(`/api/admin/servers/${server.uuid}/transfer`, {
        node: target,
      }),
    onSuccess: async (result) => {
      setDone(result.node);
      setTarget('');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'server', server.uuid] });
    },
  });

  // The node it is already on is not an option: the API refuses it, and an
  // entry that can only produce an error does not belong in a list.
  const options = (nodes.data?.data ?? []).filter((node) => node.name !== currentNode);

  const blocked = plan.data ? plan.data.availableOnTarget === 0 : false;

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-content">
        {t('adminServer.transfer')}
      </h2>
      <p className="mb-4 text-sm text-content-muted">{t('adminServer.transferHint')}</p>

      {done ? <Alert tone="info">{t('adminServer.transferDone', { node: done })}</Alert> : null}

      {options.length === 0 ? (
        <p className="text-sm text-content-muted">{t('adminServer.transferNoNode')}</p>
      ) : (
        <div className="grid gap-4">
          <Field label={t('adminServer.transferTarget')}>
            <select
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setDone(null);
              }}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content"
            >
              <option value="">{t('adminServer.transferPick')}</option>
              {options.map((node) => (
                <option key={node.uuid} value={node.uuid}>
                  {node.name}
                </option>
              ))}
            </select>
          </Field>

          {plan.isFetching ? <Spinner /> : null}

          {plan.data ? (
            <div className="grid gap-2">
              {/* Without a free port there is nothing to move the server on to,
                  and the API would refuse. Said here instead. */}
              {plan.data.availableOnTarget === 0 ? (
                <Alert tone="danger">{t('adminServer.transferNoPort')}</Alert>
              ) : (
                <p className="text-sm text-content-muted">
                  {t('adminServer.transferPorts', { count: plan.data.availableOnTarget })}
                </p>
              )}

              {/* Not a blocker: the transfer works, the databases just stop
                  answering. Whoever presses the button should know which. */}
              {plan.data.strandedDatabases.length > 0 ? (
                <Alert tone="danger">
                  {t('adminServer.transferStranded', {
                    databases: plan.data.strandedDatabases.join(', '),
                  })}
                </Alert>
              ) : null}
            </div>
          ) : null}

          {plan.error instanceof ApiError ? (
            <Alert tone="danger">{plan.error.message}</Alert>
          ) : null}

          {transfer.error instanceof ApiError ? (
            <Alert tone="danger">{transfer.error.message}</Alert>
          ) : null}

          <div>
            <p className="mb-3 text-sm text-content-muted">{t('adminServer.transferStops')}</p>

            <Button
              variant="danger"
              disabled={target === '' || blocked || transfer.isPending}
              onClick={() => {
                // Typed, like the deletion. This one stops a running server and
                // then deletes its files on the old node.
                const typed = window.prompt(
                  t('adminServer.transferConfirm', { name: server.name }),
                );

                if (typed === server.name) {
                  transfer.mutate();
                }
              }}
            >
              {transfer.isPending ? t('adminServer.transferring') : t('adminServer.transferStart')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
