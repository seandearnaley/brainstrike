import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import { type ReactElement, useState } from 'react';
import type { WorkspaceBarMode } from './workspace-bar';

export interface WorktreeCreateDialogProps {
  readonly mode: WorkspaceBarMode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

const worktreeNameError = (name: string): string | null => {
  const trimmedName = name.trim();
  if (
    trimmedName.length === 0 ||
    trimmedName === '.' ||
    trimmedName === '..' ||
    trimmedName.includes('/') ||
    trimmedName.includes('\\')
  ) {
    return 'Worktree name must be a single path segment.';
  }
  return null;
};

/**
 * The create sheet from spec §4.3: Start from · Branch (auto `bs/<name>`,
 * editable, or detached [D2]) · Location (read-only) · Setup summary ·
 * Create & use.
 *
 * Written INSIDE ModeChip's JSX on purpose — dialog nesting depth is LEXICAL
 * (`docs/agents/ui-conventions.md`), so a hoisted dialog resolves to tier 1 and
 * its scrim paints under the panel it covers.
 *
 * A failure renders IN the sheet and leaves it open (spec §4.5): the thread
 * stays Local, and the message is the main-process one, which names the actual
 * obstacle.
 */
export function WorktreeCreateDialog({
  mode,
  onOpenChange,
  open,
}: WorktreeCreateDialogProps): ReactElement {
  const [name, setName] = useState(mode.defaultName);
  const [branch, setBranch] = useState(`${mode.defaultBranchPrefix}${mode.defaultName}`);
  const [branchTouched, setBranchTouched] = useState(false);
  const [detached, setDetached] = useState(false);
  const [baseRef, setBaseRef] = useState(mode.baseRefs[0].value);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedName = name.trim();
  const nameError = worktreeNameError(name);
  const repositorySetupConsent = mode.repositorySetupConsent;
  const consentRequired = repositorySetupConsent?.decision === null;
  const derivedBranch = branchTouched
    ? branch
    : `${mode.defaultBranchPrefix}${trimmedName || mode.defaultName}`;
  const pathSeparator = mode.managedParentPath.includes('\\') ? '\\' : '/';
  const locationName = nameError === null ? trimmedName : '...';

  const submit = (): void => {
    if (nameError || mode.pending || submitting || consentRequired) {
      return;
    }
    setSubmitting(true);
    setError(null);
    mode
      .onCreate({
        baseRef,
        branch: detached ? { detached: true } : { name: derivedBranch.trim() },
        name: trimmedName,
      })
      .then(() => {
        onOpenChange(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg" data-testid="worktree-create-dialog">
        <DialogHeader>
          <DialogTitle>Work in a new worktree</DialogTitle>
          <DialogDescription>
            An isolated copy of this repository. Your own checkout is left untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worktree-base-ref">Start from</Label>
            <Select onValueChange={setBaseRef} value={baseRef}>
              <SelectTrigger data-testid="worktree-create-base-ref" id="worktree-base-ref">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mode.baseRefs.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="worktree-name">Folder name</Label>
            <Input
              aria-invalid={nameError !== null}
              data-testid="worktree-create-name"
              id="worktree-name"
              onChange={(event) => {
                setError(null);
                setName(event.target.value);
              }}
              value={name}
            />
            {nameError ? (
              <p className="text-destructive text-xs" data-testid="worktree-create-name-error">
                {nameError}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="font-normal text-sm" htmlFor="worktree-detached">
              Detached — name the branch later
            </Label>
            <Switch
              checked={detached}
              data-testid="worktree-create-detached"
              id="worktree-detached"
              onCheckedChange={setDetached}
            />
          </div>
          {detached ? null : (
            <div className="space-y-2">
              <Label htmlFor="worktree-branch">Branch</Label>
              <Input
                data-testid="worktree-create-branch"
                id="worktree-branch"
                onChange={(event) => {
                  setBranch(event.target.value);
                  setBranchTouched(true);
                  setError(null);
                }}
                value={derivedBranch}
              />
            </div>
          )}
          <div className="space-y-1">
            <p className="font-medium text-xs">Location</p>
            <p
              className="break-all font-mono text-muted-foreground text-xs"
              data-testid="worktree-create-location"
            >
              {`${mode.managedParentPath}${pathSeparator}${locationName}`}
            </p>
            <p className="text-muted-foreground text-xs">
              Change the location in Settings → Workspace.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-xs">Setup</p>
            <p
              className="text-muted-foreground text-xs"
              data-testid="worktree-create-setup-summary"
            >
              {mode.setupSummary}
            </p>
            <p className="text-muted-foreground text-xs" data-testid="worktree-create-setup-note">
              If this repository or your Settings define a setup command, it runs after creation;
              files listed in .worktreeinclude — including gitignored ones — are copied in.
            </p>
          </div>
          {repositorySetupConsent ? (
            <div
              className="space-y-2 rounded-md border p-3"
              data-testid="worktree-repository-setup-consent"
            >
              <p className="font-medium text-sm">Run repository setup script?</p>
              <div className="space-y-1 text-muted-foreground text-xs">
                <p>
                  Repository:{' '}
                  <span className="break-all font-mono text-foreground">
                    {repositorySetupConsent.repositoryPath}
                  </span>
                </p>
                <p>
                  Script:{' '}
                  <span className="break-all font-mono text-foreground">
                    {repositorySetupConsent.scriptPath}
                  </span>
                </p>
                <p>Runs local shell code with BRAINSTRIKE_WORKSPACE_* environment variables.</p>
                <p>
                  Separately, .worktreeinclude copies — which may include gitignored files — run for
                  every new worktree regardless of this choice.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => repositorySetupConsent.onDecision('approved')}
                  size="sm"
                  type="button"
                  variant={repositorySetupConsent.decision === 'approved' ? 'default' : 'outline'}
                >
                  Allow script
                </Button>
                <Button
                  onClick={() => repositorySetupConsent.onDecision('denied')}
                  size="sm"
                  type="button"
                  variant={repositorySetupConsent.decision === 'denied' ? 'default' : 'outline'}
                >
                  Skip script
                </Button>
              </div>
            </div>
          ) : null}
          {mode.pending ? (
            <p className="text-muted-foreground text-xs" data-testid="worktree-create-pending">
              Worktree operation in progress.
            </p>
          ) : null}
          {error ? (
            <p
              className="text-destructive text-sm"
              data-testid="worktree-create-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            data-testid="worktree-create-submit"
            disabled={submitting || mode.pending || nameError !== null || consentRequired}
            onClick={submit}
            type="button"
          >
            {submitting ? 'Creating…' : 'Create & use'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
