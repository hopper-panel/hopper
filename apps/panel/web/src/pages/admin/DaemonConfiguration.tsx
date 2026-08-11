import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { ApiError, api } from '../../lib/api';

interface ApplyStatus {
  state: 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';
  /** Whether this machine can configure itself at all — see the note below. */
  available: boolean;
  log?: string;
  /** What to run by hand when it cannot. */
  manualCommand: string;
}

/**
 * The document a new node needs, and the button that saves copying it.
 *
 * Three manual steps used to follow this screen — write the file, `chmod 600`,
 * restart hopperd — and the middle one is the one that bites: a file left at
 * 0644 makes hopperd exit 78 at every start, while the panel reports the node
 * as merely unreachable. An operator lost an evening to it after piping the
 * document through `tee`, which recreates the file at the shell's umask.
 *
 * So the panel offers to do it, for the machine it runs on. The document stays
 * on screen because a second machine still needs it: nothing here can write a
 * root-owned file on somebody else's host, and it should not be able to.
 *
 * What the outcome was is asked for rather than assumed. The first version said
 * "this machine is writing the file" and stopped there, which is a promise, not
 * a result: the root-side unit can fail — a node uuid it will not accept, a
 * `daemon.yml` it cannot write — and the screen that told the operator to go and
 * run `hopper doctor` was the last thing they heard from it.
 */
export function DaemonConfiguration({
  nodeUuid,
  value,
  onDismiss,
}: {
  nodeUuid: string;
  value: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);

  const status = useQuery({
    queryKey: ['admin', 'nodes', 'local-apply'],
    queryFn: () => api.get<ApplyStatus>('/api/admin/nodes/local-apply/status'),
    retry: false,
    // Polled only between the request and its outcome, and stopped on either.
    // Restarting hopperd does not restart the panel, so unlike an update this
    // conversation is never interrupted: the answer really does arrive.
    refetchInterval: (query) => {
      const state = query.state.data?.state;

      if (!applied || state === 'succeeded' || state === 'failed') {
        return false;
      }

      return 2000;
    },
  });

  // Read only once the operator has asked for something. A `succeeded` left
  // over from an earlier node would otherwise report this one as configured
  // before anybody pressed anything.
  const state = applied ? status.data?.state : undefined;
  const running = applied && state !== 'succeeded' && state !== 'failed';

  const applyLocally = useMutation({
    mutationFn: () => api.post<ApplyStatus>(`/api/admin/nodes/${nodeUuid}/apply-locally`, {}),
    onSuccess: () => {
      setApplied(true);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', 'local-apply'] });
    },
  });

  // Absent when the status has not answered yet, and only then: an installation
  // without the root-side unit, or one where the panel's account cannot write
  // the directory the request goes in, is told so instead of being handed a
  // button that fails when pressed. That machine existed — the units shipped a
  // release before the directory they share, and the button answered "Internal
  // server error".
  const unavailable = status.data?.available === false;

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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? t('adminNodes.copied') : t('adminNodes.copy')}
        </Button>

        {unavailable ? null : (
          <Button
            variant="primary"
            disabled={applyLocally.isPending || running || state === 'succeeded'}
            onClick={() => applyLocally.mutate()}
          >
            {running || applyLocally.isPending
              ? t('adminNodes.applying')
              : t('adminNodes.applyHere')}
          </Button>
        )}
      </div>

      {/* The commands to run instead, on a machine that cannot do it itself. */}
      {unavailable ? (
        <p className="mt-3 text-sm text-content-muted">
          {t('adminNodes.applyManual', { command: status.data?.manualCommand ?? '' })}
        </p>
      ) : null}

      {running ? <p className="mt-3 text-sm text-content">{t('adminNodes.applyStarted')}</p> : null}

      {state === 'succeeded' ? (
        <p className="mt-3 text-sm text-online">{t('adminNodes.applyDone')}</p>
      ) : null}

      {/* The unit's own journal, when it failed. Printed rather than summarised:
          what it says is the only thing that distinguishes a refused uuid from
          a daemon that would not restart. */}
      {state === 'failed' ? (
        <div className="mt-3 space-y-2">
          <Alert>{t('adminNodes.applyFailed')}</Alert>
          {status.data?.log ? (
            <pre className="max-h-40 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs text-danger">
              {status.data.log}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* The API refuses when this machine cannot act, and its message carries
          the commands to run instead. Rendered rather than swallowed: it is the
          whole of the fallback. */}
      {applyLocally.error instanceof ApiError ? (
        <div className="mt-3">
          <Alert>{applyLocally.error.message}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
