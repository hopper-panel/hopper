import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useTranslation } from '../i18n';
import { useServerContext } from '../lib/server-context';

interface Variable {
  envVariable: string;
  name: string;
  description: string;
  value: string;
  defaultValue: string;
  editable: boolean;
  rules: string;
}

interface Startup {
  startupCommand: string;
  dockerImage: string;
  dockerImages: { name: string; image: string }[];
  variables: Variable[];
}

export function ServerStartupPage() {
  const { uuid = '' } = useParams();
  const queryClient = useQueryClient();
  const { can } = useServerContext();
  const { t } = useTranslation();

  const [values, setValues] = useState<Record<string, string>>({});
  const [image, setImage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const startup = useQuery({
    queryKey: ['server', uuid, 'startup'],
    queryFn: () => api.get<Startup>(`/api/servers/${uuid}/startup`),
    refetchOnWindowFocus: false,
  });

  // The fields start from the server's values, but what is being typed must
  // not be overwritten by a refetch: the local copy is taken on the first
  // arrival of the data, and after each save.
  useEffect(() => {
    if (startup.data && image === null) {
      setValues(
        Object.fromEntries(
          startup.data.variables.map((variable) => [variable.envVariable, variable.value]),
        ),
      );
      setImage(startup.data.dockerImage);
    }
  }, [startup.data, image]);

  const save = useMutation({
    mutationFn: (body: { variables?: Record<string, string>; dockerImage?: string }) =>
      api.patch<Startup>(`/api/servers/${uuid}/startup`, body),
    onSuccess: (data) => {
      setFailure(null);
      setSaved(true);
      setValues(
        Object.fromEntries(
          data.variables.map((variable) => [variable.envVariable, variable.value]),
        ),
      );
      setImage(data.dockerImage);
      void queryClient.invalidateQueries({ queryKey: ['server', uuid, 'startup'] });
    },
    onError: (error: unknown) => {
      setSaved(false);
      setFailure(error instanceof ApiError ? error.message : t('startup.saveFailed'));
    },
  });

  if (startup.isLoading || !startup.data) {
    return <Spinner label={t('common.loading')} />;
  }

  const data = startup.data;
  const canEdit = can('startup.update');
  const canChangeImage = can('startup.docker-image');

  const editable = data.variables.filter((variable) => variable.editable);
  const dirty =
    image !== data.dockerImage ||
    editable.some((variable) => (values[variable.envVariable] ?? '') !== variable.value);

  return (
    <>
      <PageHeader
        title={t('startup.title')}
        description={t('startup.subtitle')}
        action={
          canEdit ? (
            <div className="flex items-center gap-2">
              {saved && !dirty ? <Badge tone="online">{t('startup.saved')}</Badge> : null}
              <Button
                variant="primary"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate({
                    variables: Object.fromEntries(
                      editable.map((variable) => [
                        variable.envVariable,
                        values[variable.envVariable] ?? '',
                      ]),
                    ),
                    ...(canChangeImage && image !== data.dockerImage && image
                      ? { dockerImage: image }
                      : {}),
                  })
                }
              >
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          {/* Validation refusals arrive as several lines, one per
              variable: flattening them would hide what needs fixing. */}
          <Alert tone="danger">
            <span className="whitespace-pre-line">{failure}</span>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-medium text-content">{t('startup.command')}</h2>
          <pre className="overflow-x-auto rounded-lg bg-[#14161c] p-3 font-mono text-xs leading-relaxed text-content">
            {data.startupCommand}
          </pre>
          {/* The line belongs to the template: letting it be edited by
              a server user would amount to letting them choose which program
              runs inside the container. */}
          <p className="mt-2 text-xs text-content-muted">{t('startup.commandHint')}</p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium text-content">{t('startup.image')}</h2>

          <select
            className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content disabled:opacity-60"
            value={image ?? data.dockerImage}
            disabled={!canChangeImage || data.dockerImages.length === 0}
            onChange={(event) => setImage(event.target.value)}
          >
            {data.dockerImages.map((candidate) => (
              <option key={candidate.image} value={candidate.image}>
                {candidate.name}
              </option>
            ))}
            {/* The image in use may no longer be listed in the template:
                showing it anyway avoids displaying a value other than the one
                actually in use. */}
            {data.dockerImages.every((candidate) => candidate.image !== data.dockerImage) ? (
              <option value={data.dockerImage}>{data.dockerImage}</option>
            ) : null}
          </select>

          <p className="mt-2 text-xs text-content-muted">
            {canChangeImage ? t('startup.imageHint') : t('startup.imageDenied')}
          </p>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold text-content">{t('startup.variables')}</h2>

      {data.variables.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">{t('startup.noVariables')}</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.variables.map((variable) => (
            <Card key={variable.envVariable}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-content">{variable.name}</span>
                <code className="font-mono text-xs text-content-subtle">
                  {variable.envVariable}
                </code>
                {!variable.editable ? <Badge>{t('startup.readOnly')}</Badge> : null}
              </div>

              <Input
                value={variable.editable ? (values[variable.envVariable] ?? '') : variable.value}
                readOnly={!variable.editable || !canEdit}
                disabled={!variable.editable || !canEdit}
                onChange={(event) =>
                  setValues((previous) => ({
                    ...previous,
                    [variable.envVariable]: event.target.value,
                  }))
                }
              />

              {variable.description ? (
                <p className="mt-2 text-xs text-content-muted">{variable.description}</p>
              ) : null}

              {variable.editable ? (
                <p className="mt-1 font-mono text-xs text-content-subtle">{variable.rules}</p>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-content-muted">{t('startup.nextBoot')}</p>
    </>
  );
}
