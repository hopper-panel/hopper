import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../i18n';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/format';
import {
  passkeysSupported,
  registerPasskey,
  wasCancelled,
  type PasskeySummary,
} from '../lib/passkeys';
import { Alert, Badge, Button, Card, Field, Input } from './ui';

/**
 * The account's passkeys.
 *
 * Registration happens inside an authenticated session, which is what makes it
 * safe: the account is already proven, and the passkey is only being added as
 * another way back into it. Nothing here can create an account or recover one.
 */
export function PasskeysCard() {
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const supported = passkeysSupported();

  const passkeys = useQuery({
    queryKey: ['account', 'passkeys'],
    queryFn: () => api.get<PasskeySummary[]>('/api/auth/passkeys'),
    enabled: supported,
  });

  const reload = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['account', 'passkeys'] });

  const register = useMutation({
    mutationFn: () => registerPasskey(name.trim() || t('passkeys.defaultName')),
    onSuccess: async () => {
      setName('');
      setAdding(false);
      setFailure(null);
      await reload();
    },
    onError: (error) => {
      // Pressing Escape is not a failure. Saying so would teach the user to
      // distrust a message that is usually right.
      if (wasCancelled(error)) {
        setFailure(null);
        return;
      }

      setFailure(error instanceof ApiError ? error.message : t('passkeys.registerFailed'));
    },
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/api/auth/passkeys/${id}`),
    onSuccess: reload,
  });

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content">
        {t('passkeys.title')}
      </h2>

      <p className="mb-4 text-sm text-content-muted">{t('passkeys.intro')}</p>

      {/* Said once, plainly, instead of a button that fails on click. */}
      {!supported ? <Alert tone="info">{t('passkeys.unsupported')}</Alert> : null}

      {supported ? (
        <>
          {passkeys.data && passkeys.data.length > 0 ? (
            <ul className="mb-4 grid gap-2">
              {passkeys.data.map((passkey) => (
                <li
                  key={passkey.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle/50 pb-2 text-sm last:border-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-content">{passkey.name}</span>

                      {/* One bound to a single device dies with that device.
                          Worth knowing before it is the only one left. */}
                      {passkey.backedUp ? (
                        <Badge tone="online">{t('passkeys.synced')}</Badge>
                      ) : (
                        <Badge tone="warn">{t('passkeys.deviceBound')}</Badge>
                      )}
                    </div>

                    <span className="text-xs text-content-subtle">
                      {passkey.lastUsedAt
                        ? t('passkeys.lastUsed', {
                            date: formatDate(passkey.lastUsedAt, locale),
                          })
                        : t('passkeys.neverUsed')}
                    </span>
                  </div>

                  <Button variant="danger" onClick={() => remove.mutate(passkey.id)}>
                    {t('passkeys.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-content-muted">{t('passkeys.empty')}</p>
          )}

          {failure ? <Alert tone="danger">{failure}</Alert> : null}

          {adding ? (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                register.mutate();
              }}
            >
              <Field label={t('passkeys.name')} hint={t('passkeys.nameHint')}>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  placeholder={t('passkeys.defaultName')}
                />
              </Field>

              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={register.isPending}>
                  {register.isPending ? t('passkeys.waiting') : t('passkeys.continue')}
                </Button>
                <Button type="button" onClick={() => setAdding(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => setAdding(true)}>{t('passkeys.add')}</Button>
          )}
        </>
      ) : null}
    </Card>
  );
}
