import { Alert, Badge, Button, Card, Field, Input } from '../../components/ui';
import { useTranslation } from '../../i18n';
import { formatUsedBytes } from '../../lib/format';
import type { DraftError, TemplateDraft, VariableDraft } from '../../lib/template-draft';

/**
 * The bodies of the template editor's five tabs.
 *
 * Split off the page for the reason the administration's server page was:
 * everything a template holds in one file is a file nobody can hold in their
 * head. The page above owns the draft and the save; each tab here is a view of
 * part of it and changes it through one `patch`.
 */

const TEXTAREA =
  'w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted focus:border-accent focus:outline-none';

const MONO = `${TEXTAREA} font-mono`;

export interface TabProps {
  draft: TemplateDraft;
  patch: (partial: Partial<TemplateDraft>) => void;
  errors: DraftError[];
  /** Existing groups, so a template can be moved without typing a name exactly. */
  groups: string[];
}

function errorFor(errors: DraftError[], field: DraftError['field']): string | undefined {
  return errors.find((error) => error.field === field)?.message;
}

/** What the template is and what it runs. */
export function GeneralTab({ draft, patch, errors, groups }: TabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('adminTemplate.name')}>
            <Input
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              maxLength={100}
              required
            />
          </Field>

          <Field label={t('adminTemplate.key')} hint={t('adminTemplate.keyHint')}>
            <Input
              value={draft.key}
              onChange={(event) => patch({ key: event.target.value })}
              placeholder="paper"
              className="font-mono"
              required
            />
          </Field>

          <Field label={t('adminTemplate.author')}>
            <Input
              value={draft.author}
              onChange={(event) => patch({ author: event.target.value })}
              maxLength={100}
            />
          </Field>

          <Field label={t('adminTemplate.group')} hint={t('adminTemplate.groupHint')}>
            <select
              value={draft.group}
              onChange={(event) => patch({ group: event.target.value })}
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
            >
              {/* The draft's own group is offered even when the list has not
                  arrived, so the select never silently moves a template. */}
              {(groups.includes(draft.group) ? groups : [draft.group, ...groups]).map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-4">
          <Field label={t('adminTemplate.description')}>
            <textarea
              value={draft.description}
              onChange={(event) => patch({ description: event.target.value })}
              maxLength={1000}
              rows={2}
              className={TEXTAREA}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-medium text-content">{t('adminTemplate.images')}</h2>
        <p className="mt-1 text-sm text-content-muted">{t('adminTemplate.imagesHint')}</p>

        {errorFor(errors, 'dockerImages') ? (
          <div className="mt-4">
            <Alert>{errorFor(errors, 'dockerImages')}</Alert>
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          {draft.dockerImages.map((image, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                value={image.name}
                onChange={(event) =>
                  patch({
                    dockerImages: draft.dockerImages.map((row, at) =>
                      at === index ? { ...row, name: event.target.value } : row,
                    ),
                  })
                }
                placeholder={t('adminTemplate.imageName')}
                className="w-40 shrink-0"
              />

              <Input
                value={image.image}
                onChange={(event) =>
                  patch({
                    dockerImages: draft.dockerImages.map((row, at) =>
                      at === index ? { ...row, image: event.target.value } : row,
                    ),
                  })
                }
                placeholder="eclipse-temurin:21-jre-noble"
                className="min-w-0 flex-1 font-mono"
              />

              {index === 0 ? <Badge>{t('adminTemplate.defaultImage')}</Badge> : null}

              <Button
                variant="ghost"
                onClick={() =>
                  patch({ dockerImages: draft.dockerImages.filter((_, at) => at !== index) })
                }
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
        </div>

        <Button
          className="mt-3"
          onClick={() => patch({ dockerImages: [...draft.dockerImages, { name: '', image: '' }] })}
        >
          {t('adminTemplate.addImage')}
        </Button>
      </Card>

      <Card>
        <Field label={t('adminTemplate.startup')} hint={t('adminTemplate.startupHint')}>
          <textarea
            value={draft.startup}
            onChange={(event) => patch({ startup: event.target.value })}
            rows={3}
            className={MONO}
            required
          />
        </Field>
      </Card>
    </div>
  );
}

/** How a server built from it starts, reports ready, and stops. */
export function ProcessTab({ draft, patch, errors }: TabProps) {
  const { t } = useTranslation();
  const stop = draft.stop;

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="font-medium text-content">{t('adminTemplate.stopTitle')}</h2>
        <p className="mt-1 text-sm text-content-muted">{t('adminTemplate.stopHint')}</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label={t('adminTemplate.stopType')}>
            <select
              value={stop.type}
              onChange={(event) =>
                patch({ stop: { ...stop, type: event.target.value as typeof stop.type } })
              }
              className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
            >
              <option value="">{t('adminTemplate.stopNone')}</option>
              <option value="command">{t('adminTemplate.stopCommandType')}</option>
              <option value="signal">{t('adminTemplate.stopSignalType')}</option>
              <option value="rcon">{t('adminTemplate.stopRconType')}</option>
            </select>
          </Field>

          {stop.type === '' ? (
            <Field label={t('adminTemplate.stopCommand')} hint={t('adminTemplate.stopCommandHint')}>
              <Input
                value={draft.stopCommand}
                onChange={(event) => patch({ stopCommand: event.target.value })}
                placeholder="command:stop"
                className="font-mono"
              />
            </Field>
          ) : null}

          {stop.type === 'command' ? (
            <Field label={t('adminTemplate.stopWhatToType')}>
              <Input
                value={stop.command}
                onChange={(event) => patch({ stop: { ...stop, command: event.target.value } })}
                placeholder="stop"
                className="font-mono"
              />
            </Field>
          ) : null}

          {stop.type === 'signal' ? (
            <Field label={t('adminTemplate.stopSignal')}>
              <select
                value={stop.signal}
                onChange={(event) =>
                  patch({ stop: { ...stop, signal: event.target.value as typeof stop.signal } })
                }
                className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-content focus:border-accent focus:outline-none"
              >
                <option value="SIGTERM">SIGTERM</option>
                <option value="SIGINT">SIGINT</option>
                <option value="SIGKILL">SIGKILL</option>
              </select>
            </Field>
          ) : null}
        </div>

        {stop.type === 'rcon' ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label={t('adminTemplate.rconCommand')} hint={t('adminTemplate.rconCommandHint')}>
              <Input
                value={stop.rconCommand}
                onChange={(event) => patch({ stop: { ...stop, rconCommand: event.target.value } })}
                placeholder="quit"
                className="font-mono"
              />
            </Field>

            <Field label={t('adminTemplate.rconRole')} hint={t('adminTemplate.rconRoleHint')}>
              <Input
                value={stop.rconRole}
                onChange={(event) => patch({ stop: { ...stop, rconRole: event.target.value } })}
                placeholder="rcon"
                className="font-mono"
              />
            </Field>

            <Field label={t('adminTemplate.rconSecret')} hint={t('adminTemplate.rconSecretHint')}>
              <Input
                value={stop.rconSecretVariable}
                onChange={(event) =>
                  patch({ stop: { ...stop, rconSecretVariable: event.target.value } })
                }
                placeholder="RCON_PASSWORD"
                className="font-mono"
              />
            </Field>
          </div>
        ) : null}

        <div className="mt-4 sm:w-1/2">
          <Field
            label={t('adminTemplate.stopTimeout')}
            hint={t('adminTemplate.stopTimeoutHint')}
            error={errorFor(errors, 'stopTimeoutSeconds')}
          >
            <Input
              type="number"
              min={1}
              max={600}
              value={draft.stopTimeoutSeconds}
              onChange={(event) => patch({ stopTimeoutSeconds: event.target.value })}
              placeholder="30"
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="font-medium text-content">{t('adminTemplate.readyTitle')}</h2>
        <p className="mt-1 text-sm text-content-muted">{t('adminTemplate.readyHint')}</p>

        <div className="mt-4 space-y-4">
          <Field
            label={t('adminTemplate.startupDetection')}
            hint={t('adminTemplate.startupDetectionHint')}
          >
            <Input
              value={draft.startupDetection}
              onChange={(event) => patch({ startupDetection: event.target.value })}
              placeholder=") Done ("
              className="font-mono"
            />
          </Field>

          <Field
            label={t('adminTemplate.readiness')}
            hint={t('adminTemplate.readinessHint')}
            error={errorFor(errors, 'readiness')}
          >
            <textarea
              value={draft.readiness}
              onChange={(event) => patch({ readiness: event.target.value })}
              rows={6}
              spellCheck={false}
              placeholder={'{\n  "type": "port",\n  "role": "query",\n  "protocol": "udp"\n}'}
              className={MONO}
            />
          </Field>
        </div>
      </Card>
    </div>
  );
}

/** What the daemon rewrites in the server's files, and what it refuses to touch. */
export function FilesTab({ draft, patch, errors }: TabProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card>
        <Field
          label={t('adminTemplate.configFiles')}
          hint={t('adminTemplate.configFilesHint')}
          error={errorFor(errors, 'configFiles')}
        >
          <textarea
            value={draft.configFiles}
            onChange={(event) => patch({ configFiles: event.target.value })}
            rows={16}
            spellCheck={false}
            className={MONO}
          />
        </Field>
      </Card>

      <Card>
        <Field label={t('adminTemplate.fileDenylist')} hint={t('adminTemplate.fileDenylistHint')}>
          <textarea
            value={draft.fileDenylist}
            onChange={(event) => patch({ fileDenylist: event.target.value })}
            rows={4}
            spellCheck={false}
            className={MONO}
          />
        </Field>
      </Card>
    </div>
  );
}

/** The one-off container that puts the game on disk. */
export function InstallTab({ draft, patch, errors }: TabProps) {
  const { t } = useTranslation();
  const disk = Number(draft.installRequiredDiskBytes);

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('adminTemplate.installContainer')}
            hint={t('adminTemplate.installContainerHint')}
          >
            <Input
              value={draft.installContainer}
              onChange={(event) => patch({ installContainer: event.target.value })}
              className="font-mono"
              required
            />
          </Field>

          <Field label={t('adminTemplate.installEntrypoint')}>
            <Input
              value={draft.installEntrypoint}
              onChange={(event) => patch({ installEntrypoint: event.target.value })}
              className="font-mono"
              required
            />
          </Field>

          <Field
            label={t('adminTemplate.installTimeout')}
            hint={t('adminTemplate.installTimeoutHint')}
            error={errorFor(errors, 'installInactivityTimeoutMs')}
          >
            <Input
              type="number"
              min={1}
              value={draft.installInactivityTimeoutMs}
              onChange={(event) => patch({ installInactivityTimeoutMs: event.target.value })}
              placeholder="900000"
            />
          </Field>

          <Field
            label={t('adminTemplate.installDisk')}
            // The figure is entered in bytes because that is what the contract
            // carries and what a Steam depot's size is quoted in; the readable
            // form beside it is there so a typo of three orders of magnitude is
            // visible before it refuses every installation on the node.
            hint={
              Number.isFinite(disk) && draft.installRequiredDiskBytes.trim() !== ''
                ? `${t('adminTemplate.installDiskHint')} — ${formatUsedBytes(disk)}`
                : t('adminTemplate.installDiskHint')
            }
            error={errorFor(errors, 'installRequiredDiskBytes')}
          >
            <Input
              type="number"
              min={0}
              value={draft.installRequiredDiskBytes}
              onChange={(event) => patch({ installRequiredDiskBytes: event.target.value })}
              placeholder="6919647587"
            />
          </Field>
        </div>
      </Card>

      <Card>
        <Field label={t('adminTemplate.installScript')} hint={t('adminTemplate.installScriptHint')}>
          <textarea
            value={draft.installScript}
            onChange={(event) => patch({ installScript: event.target.value })}
            rows={20}
            spellCheck={false}
            className={MONO}
            required
          />
        </Field>
      </Card>
    </div>
  );
}

/** The environment the container is given, and who may change what. */
export function VariablesTab({ draft, patch }: TabProps) {
  const { t } = useTranslation();

  function setVariable(index: number, partial: Partial<VariableDraft>): void {
    patch({
      variables: draft.variables.map((row, at) => (at === index ? { ...row, ...partial } : row)),
    });
  }

  function move(index: number, by: number): void {
    const row = draft.variables[index];
    const target = index + by;

    if (!row || target < 0 || target >= draft.variables.length) {
      return;
    }

    const variables = draft.variables.filter((_, at) => at !== index);
    variables.splice(target, 0, row);
    patch({ variables });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-content-muted">{t('adminTemplate.variablesHint')}</p>

      {draft.variables.map((variable, index) => (
        <Card key={variable.rowId}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('adminTemplate.varName')}>
              <Input
                value={variable.name}
                onChange={(event) => setVariable(index, { name: event.target.value })}
              />
            </Field>

            <Field label={t('adminTemplate.varEnv')} hint={t('adminTemplate.varEnvHint')}>
              <Input
                value={variable.envVariable}
                onChange={(event) => setVariable(index, { envVariable: event.target.value })}
                className="font-mono"
              />
            </Field>

            <Field label={t('adminTemplate.varDefault')}>
              <Input
                value={variable.defaultValue}
                onChange={(event) => setVariable(index, { defaultValue: event.target.value })}
                className="font-mono"
              />
            </Field>

            <Field label={t('adminTemplate.varRules')} hint={t('adminTemplate.varRulesHint')}>
              <Input
                value={variable.rules}
                onChange={(event) => setVariable(index, { rules: event.target.value })}
                className="font-mono"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label={t('adminTemplate.varDescription')}>
              <Input
                value={variable.description}
                onChange={(event) => setVariable(index, { description: event.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs text-content-muted">
                <input
                  type="checkbox"
                  checked={variable.userViewable}
                  onChange={(event) => setVariable(index, { userViewable: event.target.checked })}
                />
                {t('adminTemplate.varViewable')}
              </label>

              <label className="flex items-center gap-2 text-xs text-content-muted">
                <input
                  type="checkbox"
                  checked={variable.userEditable}
                  onChange={(event) => setVariable(index, { userEditable: event.target.checked })}
                />
                {t('adminTemplate.varEditable')}
              </label>
            </div>

            <div className="flex gap-1">
              <Button variant="ghost" onClick={() => move(index, -1)} disabled={index === 0}>
                {t('adminTemplate.moveUp')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => move(index, 1)}
                disabled={index === draft.variables.length - 1}
              >
                {t('adminTemplate.moveDown')}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  patch({ variables: draft.variables.filter((_, at) => at !== index) })
                }
              >
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </Card>
      ))}

      <Button
        onClick={() =>
          patch({
            variables: [
              ...draft.variables,
              {
                // Unique against every row that has ever existed in this draft,
                // rather than the length: removing a row and adding another
                // would otherwise reuse a key React still has state under.
                rowId: nextRowId(draft.variables),
                name: '',
                description: '',
                envVariable: '',
                defaultValue: '',
                userViewable: true,
                // The definition's own default, and the conservative one: an
                // editable variable is user input reaching the startup command.
                userEditable: false,
                rules: 'nullable|string',
              },
            ],
          })
        }
      >
        {t('adminTemplate.addVariable')}
      </Button>
    </div>
  );
}

function nextRowId(variables: readonly VariableDraft[]): number {
  return variables.reduce((highest, variable) => Math.max(highest, variable.rowId), -1) + 1;
}
