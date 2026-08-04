import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Alert, Badge, Button, Card, Input, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';
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

  const [values, setValues] = useState<Record<string, string>>({});
  const [image, setImage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const startup = useQuery({
    queryKey: ['server', uuid, 'startup'],
    queryFn: () => api.get<Startup>(`/api/servers/${uuid}/startup`),
    refetchOnWindowFocus: false,
  });

  // Les champs partent des valeurs du serveur, mais la saisie en cours ne doit
  // pas être écrasée par un rechargement : la copie locale n'est faite qu'à la
  // première arrivée des données, et après chaque enregistrement.
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
      setFailure(error instanceof ApiError ? error.message : 'Enregistrement impossible.');
    },
  });

  if (startup.isLoading || !startup.data) {
    return <Spinner label="Chargement des paramètres de démarrage…" />;
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
        title="Démarrage"
        description="Ce que le serveur exécute au lancement, et les variables du template."
        action={
          canEdit ? (
            <div className="flex items-center gap-2">
              {saved && !dirty ? <Badge tone="online">enregistré</Badge> : null}
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
                {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
            </div>
          ) : null
        }
      />

      {failure ? (
        <div className="mb-4">
          {/* Les refus de validation arrivent en plusieurs lignes, une par
              variable : les aplatir rendrait illisible ce qui est à corriger. */}
          <Alert tone="danger">
            <span className="whitespace-pre-line">{failure}</span>
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-medium text-content">Commande de démarrage</h2>
          <pre className="overflow-x-auto rounded-lg bg-[#14161c] p-3 font-mono text-xs leading-relaxed text-content">
            {data.startupCommand}
          </pre>
          {/* Le gabarit appartient au template : le laisser modifier par
              l'utilisateur d'un serveur reviendrait à lui donner le choix du
              programme exécuté dans le conteneur. */}
          <p className="mt-2 text-xs text-content-muted">
            Définie par le template. Les <code>{'{{VARIABLES}}'}</code> ci-dessous y sont
            substituées au lancement.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium text-content">Image Docker</h2>

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
            {/* L'image en place peut ne plus figurer dans le template : la
                montrer quand même évite d'afficher une autre valeur que celle
                réellement utilisée. */}
            {data.dockerImages.every((candidate) => candidate.image !== data.dockerImage) ? (
              <option value={data.dockerImage}>{data.dockerImage}</option>
            ) : null}
          </select>

          <p className="mt-2 text-xs text-content-muted">
            {canChangeImage
              ? 'Version de Java qui exécute le serveur. Une image inadaptée empêche le démarrage.'
              : 'Vous n’avez pas la permission de changer l’image.'}
          </p>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold text-content">Variables</h2>

      {data.variables.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">Ce template n’expose aucune variable.</p>
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
                {!variable.editable ? <Badge>lecture seule</Badge> : null}
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

      <p className="mt-4 text-xs text-content-muted">
        Les changements prennent effet au <strong>prochain démarrage</strong> : la commande et les
        variables sont appliquées au lancement du conteneur.
      </p>
    </>
  );
}
