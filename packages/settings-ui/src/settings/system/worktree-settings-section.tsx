import type { WorktreeSettings } from '@brainstrike/types';
import { Badge, Button, Input, Label } from '@brainstrike/ui';
import { type ReactElement, useState } from 'react';

export type WorktreeSettingsStatus =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable' };

export interface WorktreeSettingsSectionProps {
  readonly onSave: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
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
  const [directory, setDirectory] = useState(settings?.managedDirectory ?? '');
  const [command, setCommand] = useState((settings?.setupCommand ?? []).join(' '));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (status.kind === 'unavailable') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="worktree-settings-unavailable">
        Worktrees are a desktop feature. This build has no worktree bridge, so there is nothing to
        configure here.
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

  const save = (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }): void => {
    setSaving(true);
    setSaveError(null);
    onSave(next)
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const commandParts = command.trim().length > 0 ? command.trim().split(/\s+/u) : null;

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
          onChange={(event) => setDirectory(event.target.value)}
          value={directory}
        />
        <p className="text-muted-foreground text-xs">
          Worktrees BrainStrike creates live under this folder. It must sit outside every connected
          workspace folder — an in-folder location would be indexed and watched as part of that
          folder.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="worktree-setup-command">Setup command (optional)</Label>
        <Input
          data-testid="worktree-settings-setup-command"
          id="worktree-setup-command"
          onChange={(event) => setCommand(event.target.value)}
          placeholder="pnpm install --frozen-lockfile"
          value={command}
        />
        <p className="text-muted-foreground text-xs">
          Runs once in each new worktree with{' '}
          <code>BRAINSTRIKE_WORKSPACE_NAME/PATH/ROOT_PATH/PORT</code> set. Leave empty to use the
          repository&rsquo;s <code>.brainstrike/worktree-setup.sh</code> when it has one.
        </p>
      </div>
      {saveError ? (
        <p className="text-destructive text-sm" data-testid="worktree-settings-error">
          {saveError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="worktree-settings-save"
          disabled={saving}
          onClick={() =>
            save({
              managedDirectory: directory.trim().length > 0 ? directory.trim() : null,
              setupCommand: commandParts,
            })
          }
          type="button"
        >
          Save
        </Button>
        <Button
          data-testid="worktree-settings-reset"
          disabled={saving || settings.isDefaultDirectory}
          onClick={() => {
            setDirectory('');
            save({ managedDirectory: null, setupCommand: commandParts });
          }}
          type="button"
          variant="outline"
        >
          Use the default location
        </Button>
      </div>
    </div>
  );
}
