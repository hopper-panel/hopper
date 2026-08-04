import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '../../components/ui';
import { ApiError, api, type Paginated, type UserSummary } from '../../lib/api';
import { useTranslation } from '../../i18n';
import { formatDate } from '../../lib/format';
import { useAuth } from '../../lib/auth';

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<Paginated<UserSummary>>('/api/admin/users'),
  });

  const [notice, setNotice] = useState<string | null>(null);
  const { t, locale } = useTranslation();

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<UserSummary & { invitationSent: boolean }>('/api/admin/users', body),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      setCreating(false);
      setNotice(
        created.invitationSent
          ? t('adminUsers.invitationSent', { email: created.email })
          : t('adminUsers.invitationNotSent'),
      );
    },
  });

  const inviteMutation = useMutation({
    mutationFn: (uuid: string) =>
      api.post<{ sent: boolean }>(`/api/admin/users/${uuid}/invitation`),
    onSuccess: (result) =>
      setNotice(result.sent ? t('adminUsers.resent') : t('adminUsers.resendFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (uuid: string) => api.delete<void>(`/api/admin/users/${uuid}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  if (isLoading) {
    return <Spinner />;
  }

  return (
    <>
      <PageHeader
        title={t('adminUsers.title')}
        description={t('adminUsers.count', { count: data?.meta.total ?? 0 })}
        action={
          <Button variant="primary" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Annuler' : t('adminUsers.create')}
          </Button>
        }
      />

      {creating ? (
        <CreateUserForm
          onSubmit={(body) => createMutation.mutate(body)}
          pending={createMutation.isPending}
          error={createMutation.error}
        />
      ) : null}

      {deleteMutation.error instanceof ApiError ? (
        <div className="mb-4">
          <Alert>{deleteMutation.error.message}</Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4">
          <Alert tone="info">{notice}</Alert>
        </div>
      ) : null}

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-left text-xs text-content-muted">
              <th className="px-5 py-3 font-medium">Utilisateur</th>
              <th className="px-5 py-3 font-medium">{t('adminUsers.role')}</th>
              <th className="px-5 py-3 font-medium">2FA</th>
              <th className="px-5 py-3 font-medium">{t('adminUsers.lastLogin')}</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {data?.data.map((user) => (
              <tr key={user.uuid} className="border-b border-border-subtle/50 last:border-0">
                <td className="px-5 py-3">
                  <p className="text-content">{user.username}</p>
                  <p className="text-xs text-content-muted">{user.email}</p>
                </td>
                <td className="px-5 py-3">
                  <Badge tone={user.role === 'ADMIN' ? 'warn' : 'offline'}>
                    {t(user.role === 'ADMIN' ? 'adminUsers.roleAdmin' : 'adminUsers.roleUser')}
                  </Badge>
                  {user.suspended ? (
                    <span className="ml-2">
                      <Badge tone="danger">{t('status.suspended')}</Badge>
                    </span>
                  ) : null}
                </td>
                <td className="px-5 py-3 text-content-muted">
                  {user.twoFactorEnabled ? t('adminUsers.twoFactorOn') : '—'}
                </td>
                <td className="px-5 py-3 text-content-muted">
                  {formatDate(user.lastLoginAt, locale)}
                </td>
                <td className="px-5 py-3 text-right">
                  {/* Deleting oneself is refused by the API; hiding the button
                      avoids offering an action bound to fail. */}
                  {user.uuid === currentUser?.uuid ? (
                    <span className="text-xs text-content-muted">{t('adminUsers.you')}</span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      {/* Sending a link again rather than setting a password on
                          someone's behalf: the first mail gets lost, and the
                          link expires after a day. */}
                      <Button
                        onClick={() => inviteMutation.mutate(user.uuid)}
                        disabled={inviteMutation.isPending}
                      >
                        {t('adminUsers.resend')}
                      </Button>
                      <Button variant="danger" onClick={() => deleteMutation.mutate(user.uuid)}>
                        {t('common.delete')}
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function CreateUserForm({
  onSubmit,
  pending,
  error,
}: {
  onSubmit: (body: Record<string, unknown>) => void;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ email: '', username: '', password: '', role: 'USER' });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();

    // Empty password: the field is optional, and sending it empty would fail
    // validation instead of triggering the mail invitation.
    onSubmit({
      ...form,
      password: form.password === '' ? undefined : form.password,
    });
  }

  return (
    <Card className="mb-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('adminUsers.email')}>
            <Input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </Field>

          <Field label={t('adminUsers.username')} hint={t('adminUsers.usernameHint')}>
            <Input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              pattern="[a-zA-Z0-9_-]+"
              minLength={3}
              maxLength={32}
              required
            />
          </Field>

          <Field label={t('adminUsers.password')} hint={t('adminUsers.passwordHint')}>
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              minLength={12}
              placeholder={t('adminUsers.passwordPlaceholder')}
            />
          </Field>

          <Field label={t('adminUsers.role')} hint={t('adminUsers.roleHint')}>
            <select
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value })}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
            >
              <option value="USER">{t('adminUsers.roleUser')}</option>
              <option value="ADMIN">{t('adminUsers.roleAdmin')}</option>
            </select>
          </Field>
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? t('common.saving') : t('common.create')}
        </Button>
      </form>
    </Card>
  );
}
