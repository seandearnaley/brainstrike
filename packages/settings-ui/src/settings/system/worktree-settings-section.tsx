import type { WorktreeSettings, WorktreeSetupCommand } from '@brainstrike/types';
import { Badge, Button, Checkbox, Input, Label } from '@brainstrike/ui';
import { Check } from 'lucide-react';
import { type ReactElement, useState } from 'react';

export type WorktreeSettingsStatus =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable' };

export interface WorktreeSettingsSectionProps {
  readonly onSave: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }) => Promise<void>;
  readonly settings: WorktreeSettings | null;
  readonly status: WorktreeSettingsStatus;
}

/**
 * Settings → Workspace: where managed worktrees live [D3] and the optional
 * per-worktree setup command (spec §6.3).
 *
 * NO SILENT FALLBACKS: an unavailable capability states why, a load failure
 * renders the error verbatim (never an empty form the user could "save" over
 * a corrupt value), and a save failure renders the main-process message —
 * which is the one that names the offending folder (BST-1342).
 */
export function WorktreeSettingsSection({
  onSave,
  settings,
  status,
}: WorktreeSettingsSectionProps): ReactElement {
  if (status.kind === 'unavailable') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="worktree-settings-unavailable">
        Worktrees are unavailable in this window, so there is nothing to configure here.
      </p>
    );
  }
  if (status.kind === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading worktree settings…</p>;
  }
  if (status.kind === 'error' || !settings) {
    return (
      <p className="text-destructive text-sm" data-testid="worktree-settings-error">
        {status.kind === 'error' ? status.message : 'Worktree settings could not be read.'}
      </p>
    );
  }

  return <WorktreeSettingsForm onSave={onSave} settings={settings} />;
}

const QUOTE_ERROR =
  'Quoting is not supported. Each whitespace-separated token becomes one argument.';

function sameSetupCommand(a: WorktreeSetupCommand, b: WorktreeSetupCommand): boolean {
  if (a === null || b === null || a === 'disabled' || b === 'disabled') {
    return a === b;
  }
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function WorktreeSettingsForm({
  onSave,
  settings,
}: {
  readonly onSave: WorktreeSettingsSectionProps['onSave'];
  readonly settings: WorktreeSettings;
}): ReactElement {
  const [directory, setDirectory] = useState(settings.managedDirectory);
  const [command, setCommand] = useState(() =>
    settings.setupCommand === 'disabled' ? '' : (settings.setupCommand ?? []).join(' ')
  );
  const [setupDisabled, setSetupDisabled] = useState(settings.setupCommand === 'disabled');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const commandParts = command.trim().length > 0 ? command.trim().split(/\s+/u) : null;
  const commandError = !setupDisabled && /["']/u.test(command) ? QUOTE_ERROR : null;
  const setupCommand: WorktreeSetupCommand = setupDisabled ? 'disabled' : commandParts;
  const trimmedDirectory = directory.trim();
  // An empty field means the default location, which the stored settings already
  // use when they are the default.
  const directoryChanged =
    trimmedDirectory.length > 0
      ? trimmedDirectory !== settings.managedDirectory
      : !settings.isDefaultDirectory;
  const dirty = directoryChanged || !sameSetupCommand(setupCommand, settings.setupCommand);

  const edited = (): void => {
    setSaved(false);
  };

  const save = (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }): void => {
    if (commandError) {
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    onSave(next)
      .then(() => {
        setSaved(true);
      })
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="worktree-managed-directory">Managed worktree location</Label>
          {settings.isDefaultDirectory ? (
            <Badge data-testid="worktree-settings-default-badge" variant="secondary">
              Default
            </Badge>
          ) : null}
        </div>
        <Input
          data-testid="worktree-settings-directory"
          id="worktree-managed-directory"
          onChange={(event) => {
            setDirectory(event.target.value);
            edited();
          }}
          value={directory}
        />
        <p className="text-muted-foreground text-xs">
          Worktrees Brainstrike creates live under this folder. It must sit outside every connected
          workspace folder — an in-folder location would be indexed and watched as part of that
          folder. Leave this field empty to use the default location.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="worktree-setup-command">Setup command (optional)</Label>
        <Input
          aria-describedby={commandError ? 'worktree-setup-command-error' : undefined}
          aria-invalid={commandError ? true : undefined}
          data-testid="worktree-settings-setup-command"
          disabled={setupDisabled}
          id="worktree-setup-command"
          onChange={(event) => {
            setCommand(event.target.value);
            edited();
          }}
          placeholder="pnpm install --frozen-lockfile"
          value={command}
        />
        <div className="flex items-start gap-2">
          <Checkbox
            checked={setupDisabled}
            data-testid="worktree-settings-disable-setup"
            id="worktree-disable-setup"
            onCheckedChange={(checked) => {
              setSetupDisabled(checked === true);
              edited();
            }}
          />
          <Label className="text-sm font-normal" htmlFor="worktree-disable-setup">
            Disable setup entirely; do not fall back to the repository setup script.
          </Label>
        </div>
        {commandError ? (
          <p
            className="text-destructive text-sm"
            data-testid="worktree-settings-setup-command-error"
            id="worktree-setup-command-error"
            role="alert"
          >
            {commandError}
          </p>
        ) : null}
        <p
          className="text-muted-foreground text-xs"
          data-testid="worktree-settings-setup-command-preview"
        >
          {setupDisabled
            ? 'Setup is disabled.'
            : commandParts
              ? `Runs as: [${commandParts.join(', ')}]`
              : 'Uses the repository setup script when present.'}
        </p>
        <p className="text-muted-foreground text-xs">
          Runs once in each new worktree with{' '}
          <code>BRAINSTRIKE_WORKSPACE_NAME/PATH/ROOT_PATH/PORT</code> set. Leave empty to use the
          repository&rsquo;s <code>.brainstrike/worktree-setup.sh</code> when it has one.
        </p>
      </div>
      {saveError ? (
        <p className="text-destructive text-sm" data-testid="worktree-settings-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          data-testid="worktree-settings-save"
          disabled={saving || !dirty || commandError !== null}
          onClick={() =>
            save({
              managedDirectory: trimmedDirectory.length > 0 ? trimmedDirectory : null,
              setupCommand,
            })
          }
          type="button"
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          data-testid="worktree-settings-reset"
          disabled={saving || settings.isDefaultDirectory || commandError !== null}
          onClick={() => {
            setDirectory('');
            save({ managedDirectory: null, setupCommand });
          }}
          type="button"
          variant="outline"
        >
          Use the default location
        </Button>
        {saved ? (
          <p
            className="text-success flex items-center gap-1 text-sm"
            data-testid="worktree-settings-saved"
            role="status"
          >
            <Check aria-hidden="true" className="size-4" />
            Saved
          </p>
        ) : null}
      </div>
    </div>
  );
}
