import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  Archive,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  GitBranchPlus,
  Home,
  Laptop,
  Plus,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react';
import { type ReactElement, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceBarMode, WorkspaceBarWorktreeSummary } from './workspace-bar';
import { WorktreeArchiveConfirmationDialog } from './worktree-archive-confirmation-dialog';
import { WorktreeCreateDialog } from './worktree-create-dialog';
import { WorktreePickerDialog } from './worktree-picker-dialog';

/** The current worktree's identity, branch, and setup reason (when it has one). */
const WorktreeInfo = ({
  worktree,
}: {
  readonly worktree: WorkspaceBarWorktreeSummary;
}): ReactElement => (
  <div className="px-2 py-1.5 text-xs">
    <span className="block truncate font-medium">{worktree.name}</span>
    <span className="text-muted-foreground text-2xs block truncate font-mono">{worktree.path}</span>
    <span className="text-muted-foreground text-2xs mt-0.5 block">
      {worktree.detached ? 'Detached HEAD' : (worktree.branch ?? 'Detached HEAD')}
    </span>
    {worktree.setupReason ? (
      <span
        className="text-warning text-2xs mt-1 block leading-snug"
        data-testid="workspace-bar-mode-setup-reason"
      >
        {worktree.setupReason}
      </span>
    ) : null}
  </div>
);

/** A row's label, with why the row is disabled underneath it when it is. */
const RowLabel = ({
  label,
  reason,
  reasonTestId,
}: {
  readonly label: string;
  readonly reason: string | null;
  readonly reasonTestId: string;
}): ReactElement => (
  <span className="min-w-0 flex-1">
    <span className="block">{label}</span>
    {reason ? (
      <span
        className="text-muted-foreground text-2xs block whitespace-normal"
        data-testid={reasonTestId}
      >
        {reason}
      </span>
    ) : null}
  </span>
);

/** The worktree-scoped actions — each present only when its handler exists (never a disabled stub). */
const WorktreeActions = ({
  mode,
  worktree,
}: {
  readonly mode: WorkspaceBarMode;
  readonly worktree: WorkspaceBarWorktreeSummary;
}): ReactElement => (
  <>
    {mode.onHandOffToLocal ? (
      <DropdownMenuItem
        className={mode.checkoutChangeDisabledReason ? 'items-start' : undefined}
        data-testid="workspace-bar-mode-handoff"
        disabled={mode.pending || mode.checkoutChangeDisabledReason !== null}
        onSelect={mode.onHandOffToLocal}
      >
        <Home aria-hidden="true" className="size-3.5" />
        <RowLabel
          label="Hand off to Local"
          reason={mode.checkoutChangeDisabledReason}
          reasonTestId="workspace-bar-mode-handoff-disabled-reason"
        />
      </DropdownMenuItem>
    ) : null}
    {mode.onCreateBranchHere ? (
      <DropdownMenuItem
        data-testid="workspace-bar-mode-create-branch-here"
        disabled={mode.pending}
        onSelect={() => {
          void mode
            .onCreateBranchHere?.(`${mode.defaultBranchPrefix}${worktree.name}`)
            // The app-shell handler owns the visible failure toast.
            .catch(() => undefined);
        }}
      >
        <GitBranchPlus aria-hidden="true" className="size-3.5" />
        Create branch here
      </DropdownMenuItem>
    ) : null}
    {mode.onOpenTerminal ? (
      <DropdownMenuItem
        data-testid="workspace-bar-mode-open-terminal"
        onSelect={mode.onOpenTerminal}
      >
        <TerminalSquare aria-hidden="true" className="size-3.5" />
        Open in Terminal
      </DropdownMenuItem>
    ) : null}
    {mode.onReveal ? (
      <DropdownMenuItem data-testid="workspace-bar-mode-reveal" onSelect={mode.onReveal}>
        <FolderOpen aria-hidden="true" className="size-3.5" />
        Reveal
      </DropdownMenuItem>
    ) : null}
    {mode.onArchive ? (
      <DropdownMenuItem
        className={mode.checkoutChangeDisabledReason ? 'items-start' : undefined}
        data-testid="workspace-bar-mode-archive"
        disabled={mode.pending || mode.checkoutChangeDisabledReason !== null}
        onSelect={mode.onArchive}
      >
        <Archive aria-hidden="true" className="size-3.5" />
        <RowLabel
          label="Archive worktree…"
          reason={mode.checkoutChangeDisabledReason}
          reasonTestId="workspace-bar-mode-archive-disabled-reason"
        />
      </DropdownMenuItem>
    ) : null}
  </>
);

/** The menu body: worktree identity + actions when in a worktree, or the plain Local line. */
const ModeMenuBody = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const { worktree } = mode;
  if (!worktree) {
    return (
      <div className="text-muted-foreground px-2 py-1.5 text-xs">
        Local — edits land in {mode.localPath ?? 'this folder'}.
      </div>
    );
  }
  return (
    <>
      <WorktreeInfo worktree={worktree} />
      <DropdownMenuSeparator />
      <WorktreeActions mode={mode} worktree={worktree} />
    </>
  );
};

/** A minimal menu that keeps an unavailable mode's reason visible and keyboard-accessible. */
const DiagnosticOnlyModeChip = ({
  label,
  mode,
  reason,
}: {
  readonly label: string;
  readonly mode: WorkspaceBarMode;
  readonly reason: string;
}): ReactElement => (
  <DropdownMenu>
    <DropdownMenuTrigger
      aria-label={
        mode.worktree
          ? `Worktree unavailable: ${label} — ${reason}`
          : `Checkout mode unavailable: ${reason}`
      }
      className="bs-composer-chip"
      data-setup={mode.worktree?.setupStatus ?? 'none'}
      data-testid="workspace-bar-mode-chip"
      title={reason}
      type="button"
    >
      <FolderGit2 aria-hidden="true" />
      <span className="bs-composer-chip-label">{label}</span>
      <TriangleAlert aria-hidden="true" className="text-warning" />
      <ChevronDown aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-80">
      <DropdownMenuLabel>Checkout mode unavailable</DropdownMenuLabel>
      <div
        className="text-muted-foreground text-2xs px-2 pb-2"
        data-testid="workspace-bar-mode-diagnostic"
      >
        {reason}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
);

/**
 * Local / Worktree [D1]. "Cloud" is deliberately absent, not a disabled row:
 * there is no environment story to explain, and the omit-don't-stub convention
 * applies to a mode exactly as it does to a bridge.
 *
 * The create and picker dialogs live INSIDE this component's JSX because
 * dialog nesting depth is LEXICAL (`ui-conventions.md`): hoisting either one
 * would drop it to tier 1 and paint its scrim under the chip's own popup.
 */
export const ModeChip = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const [createOpen, setCreateOpen] = useState(false);
  const chipTriggerRef = useRef<HTMLButtonElement>(null);
  const shouldRestoreCreateFocusRef = useRef(false);
  const { worktree } = mode;
  const label = worktree ? worktree.name : 'Local';

  useLayoutEffect(() => {
    if (createOpen || !shouldRestoreCreateFocusRef.current) {
      return;
    }
    shouldRestoreCreateFocusRef.current = false;
    chipTriggerRef.current?.focus();
  }, [createOpen]);

  if (mode.disabledReason) {
    return <DiagnosticOnlyModeChip label={label} mode={mode} reason={mode.disabledReason} />;
  }
  const title = worktree ? worktree.path : `Edits land in ${mode.localPath ?? 'this folder'}`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={worktree ? `Worktree: ${worktree.name}` : 'Checkout mode: Local'}
          className="bs-composer-chip"
          data-setup={worktree?.setupStatus ?? 'none'}
          data-testid="workspace-bar-mode-chip"
          ref={chipTriggerRef}
          title={title}
        >
          {worktree ? <FolderGit2 aria-hidden="true" /> : <Laptop aria-hidden="true" />}
          <span className="bs-composer-chip-label">{label}</span>
          {worktree?.setupStatus === 'failed' ? (
            <TriangleAlert aria-hidden="true" className="text-warning" />
          ) : null}
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel className="text-muted-foreground text-[10px] tracking-wide uppercase">
            Where this thread works
          </DropdownMenuLabel>
          {mode.pending ? (
            <span className="text-muted-foreground text-2xs block px-3 py-1">
              Worktree operation in progress.
            </span>
          ) : null}
          <ModeMenuBody mode={mode} />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={mode.checkoutChangeDisabledReason ? 'items-start' : undefined}
            data-testid="workspace-bar-mode-pick-worktree"
            disabled={mode.pending || mode.checkoutChangeDisabledReason !== null}
            onSelect={mode.onOpenPicker}
          >
            <FolderSearch aria-hidden="true" className="size-3.5" />
            <RowLabel
              label="Use existing worktree…"
              reason={mode.checkoutChangeDisabledReason}
              reasonTestId="workspace-bar-mode-pick-worktree-disabled-reason"
            />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="items-start"
            data-testid="workspace-bar-mode-new-worktree"
            disabled={mode.pending || mode.createDisabledReason !== null}
            onSelect={() => {
              void mode
                .onOpenCreateSheet()
                .then(() => setCreateOpen(true))
                // The app-shell handler owns the visible failure toast.
                .catch(() => undefined);
            }}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            <RowLabel
              label="New worktree…"
              reason={mode.createDisabledReason}
              reasonTestId="workspace-bar-mode-create-disabled-reason"
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {createOpen ? (
        <WorktreeCreateDialog
          mode={mode}
          onOpenChange={(next: boolean) => {
            if (!next) {
              shouldRestoreCreateFocusRef.current = true;
            }
            setCreateOpen(next);
            if (!next) {
              chipTriggerRef.current?.focus();
            }
          }}
          open={createOpen}
        />
      ) : null}
      <WorktreePickerDialog picker={mode.picker} triggerRef={chipTriggerRef} />
      {mode.archiveConfirmation ? (
        <WorktreeArchiveConfirmationDialog confirmation={mode.archiveConfirmation} />
      ) : null}
    </>
  );
};

ModeChip.displayName = 'ModeChip';
