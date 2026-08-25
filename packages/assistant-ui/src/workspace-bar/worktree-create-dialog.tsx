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
  const [detached, setDetached] = useState(false);
  const [baseRef, setBaseRef] = useState(mode.baseRefs[0]?.value ?? 'HEAD');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    setSubmitting(true);
    setError(null);
    mode
      .onCreate({
        baseRef,
        branch: detached ? { detached: true } : { name: branch.trim() },
        name: name.trim(),
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
              data-testid="worktree-create-name"
              id="worktree-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
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
                onChange={(event) => setBranch(event.target.value)}
                value={branch}
              />
            </div>
          )}
          <div className="space-y-1">
            <p className="font-medium text-xs">Location</p>
            <p
              className="break-all font-mono text-muted-foreground text-xs"
              data-testid="worktree-create-location"
            >
              {mode.managedTargetPath}
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
          </div>
          {error ? (
            <p className="text-destructive text-sm" data-testid="worktree-create-error">
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
            disabled={submitting || mode.pending || name.trim().length === 0}
            onClick={submit}
            type="button"
          >
            Create &amp; use
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
