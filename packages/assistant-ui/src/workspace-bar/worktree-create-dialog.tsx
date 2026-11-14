import {
  Button,
  Checkbox,
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
import { type ReactElement, useId, useState } from 'react';
import type { WorkspaceBarMode, WorkspaceBarRepositorySetupAnswer } from './workspace-bar';

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
  const [deciding, setDeciding] = useState(false);
  const [brainstrikeWorktreesChosen, setBrainstrikeWorktreesChosen] = useState(false);
  const brainstrikeWorktreesId = useId();
  const trimmedName = name.trim();
  const nameError = worktreeNameError(name);
  const repositorySetupConsent = mode.repositorySetupConsent;
  // While an answer is on its way to the host, the sheet waits for the host's.
  const consentRequired = repositorySetupConsent?.decision === null || deciding;
  // Sean, 2026-11-14 (BST-2501): the second answer is part of an approval, off by default. While
  // the script is approved the box shows the host's standing answer; until then, the person's
  // choice, which Allow sends.
  const approved = repositorySetupConsent?.decision === 'approved';
  const brainstrikeWorktrees = approved
    ? repositorySetupConsent.brainstrikeWorktrees
    : brainstrikeWorktreesChosen;
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

  // The host records the answer for the script it showed; a refusal (the
  // script changed since) is shown here, and the sheet keeps asking.
  const decide = (answer: WorkspaceBarRepositorySetupAnswer): void => {
    if (!repositorySetupConsent || deciding) {
      return;
    }
    setDeciding(true);
    setError(null);
    repositorySetupConsent
      .onDecision(answer)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setDeciding(false);
      });
  };

  // A change of a standing approval is recorded at once; before one, it waits for Allow.
  const changeBrainstrikeWorktrees = (next: boolean): void => {
    if (approved) {
      decide({ brainstrikeWorktrees: next, decision: 'approved' });
      return;
    }
    setBrainstrikeWorktreesChosen(next);
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
          {mode.uncommittedFolderName ? (
            <p
              className="text-muted-foreground text-xs"
              data-testid="worktree-create-uncommitted-note"
            >
              {`Uncommitted changes in ${mode.uncommittedFolderName} stay there.`}
            </p>
          ) : null}
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
            <Label className="text-sm font-normal" htmlFor="worktree-detached">
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
            <p className="text-xs font-medium">Location</p>
            <p
              className="text-muted-foreground font-mono text-xs break-all"
              data-testid="worktree-create-location"
            >
              {`${mode.managedParentPath}${pathSeparator}${locationName}`}
            </p>
            <p className="text-muted-foreground text-xs">
              Change the location in Settings → Workspace.
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Setup</p>
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
              <p className="text-sm font-medium">Run repository setup script?</p>
              <div className="text-muted-foreground space-y-1 text-xs">
                <p>
                  Repository:{' '}
                  <span className="text-foreground font-mono break-all">
                    {repositorySetupConsent.repositoryPath}
                  </span>
                </p>
                <p>
                  Script:{' '}
                  <span className="text-foreground font-mono break-all">
                    {repositorySetupConsent.scriptPath}
                  </span>
                </p>
                <p>Runs local shell code with BRAINSTRIKE_WORKSPACE_* environment variables.</p>
                <p>
                  Allowing it runs it for the worktrees you make in this repository, until the
                  script changes.
                </p>
                <p>
                  Separately, .worktreeinclude copies — which may include gitignored files — run for
                  every new worktree regardless of this choice.
                </p>
              </div>
              <div className="flex items-start gap-2 text-xs">
                <Checkbox
                  aria-describedby={`${brainstrikeWorktreesId}-when`}
                  checked={brainstrikeWorktrees}
                  className="mt-0.5"
                  data-testid="worktree-repository-setup-brainstrike-worktrees"
                  disabled={deciding}
                  id={brainstrikeWorktreesId}
                  onCheckedChange={(next) => changeBrainstrikeWorktrees(next === true)}
                />
                <div className="min-w-0 space-y-0.5">
                  <label htmlFor={brainstrikeWorktreesId}>
                    Also run it for worktrees Brainstrike makes on its own
                  </label>
                  <p className="text-muted-foreground" id={`${brainstrikeWorktreesId}-when`}>
                    When another conversation is editing the same folder, or the assistant makes a
                    worktree. Left off, those worktrees skip the script and say why.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={deciding}
                  onClick={() => decide({ brainstrikeWorktrees, decision: 'approved' })}
                  size="sm"
                  type="button"
                  variant={repositorySetupConsent.decision === 'approved' ? 'default' : 'outline'}
                >
                  Allow script
                </Button>
                <Button
                  disabled={deciding}
                  onClick={() => {
                    setBrainstrikeWorktreesChosen(false);
                    decide({ brainstrikeWorktrees: false, decision: 'denied' });
                  }}
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
