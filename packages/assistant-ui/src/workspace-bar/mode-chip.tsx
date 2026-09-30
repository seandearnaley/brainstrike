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
  FolderOpen,
  FolderSearch,
  GitBranchPlus,
  Home,
  Layers,
  Plus,
  TerminalSquare,
} from 'lucide-react';
import { type ReactElement, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceBarMode, WorkspaceBarWorktreeSummary } from './workspace-bar';
import { WorktreeArchiveConfirmationDialog } from './worktree-archive-confirmation-dialog';
import { WorktreeCreateDialog } from './worktree-create-dialog';
import { WorktreePickerDialog } from './worktree-picker-dialog';

const CHIP_CLASSES =
  'inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60';

/** The current worktree's identity, branch, and setup reason (when it has one). */
const WorktreeInfo = ({
  worktree,
}: {
  readonly worktree: WorkspaceBarWorktreeSummary;
}): ReactElement => (
  <div className="px-2 py-1.5 text-xs">
    <span className="block truncate font-medium">{worktree.name}</span>
    <span className="block truncate font-mono text-[10px] text-muted-foreground">
      {worktree.path}
    </span>
    <span className="mt-0.5 block text-[10px] text-muted-foreground">
      {worktree.detached ? 'Detached HEAD' : (worktree.branch ?? 'Detached HEAD')}
    </span>
    {worktree.setupReason ? (
      <span
        className="mt-1 block text-[10px] text-warning leading-snug"
        data-testid="workspace-bar-mode-setup-reason"
      >
        {worktree.setupReason}
      </span>
    ) : null}
  </div>
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
        data-testid="workspace-bar-mode-handoff"
        disabled={mode.pending}
        onSelect={mode.onHandOffToLocal}
      >
        <Home aria-hidden="true" className="size-3.5" />
        Hand off to Local
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
        data-testid="workspace-bar-mode-archive"
        disabled={mode.pending}
        onSelect={mode.onArchive}
      >
        <Archive aria-hidden="true" className="size-3.5" />
        Archive worktree…
      </DropdownMenuItem>
    ) : null}
  </>
);

/** The menu body: worktree identity + actions when in a worktree, or the plain Local line. */
const ModeMenuBody = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const { worktree } = mode;
  if (!worktree) {
    return (
      <div className="px-2 py-1.5 text-muted-foreground text-xs">
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
      className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
      data-setup={mode.worktree?.setupStatus ?? 'none'}
      data-testid="workspace-bar-mode-chip"
      title={reason}
      type="button"
    >
      <Layers aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-warning">!</span>
      <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-80">
      <DropdownMenuLabel>Checkout mode unavailable</DropdownMenuLabel>
      <div
        className="px-2 pb-2 text-[11px] text-muted-foreground"
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
          className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
          data-setup={worktree?.setupStatus ?? 'none'}
          data-testid="workspace-bar-mode-chip"
          ref={chipTriggerRef}
          title={title}
        >
          <Layers aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
          {worktree?.setupStatus === 'failed' ? (
            <span className="shrink-0 text-warning">!</span>
          ) : null}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Where this thread works
          </DropdownMenuLabel>
          {mode.pending ? (
            <span className="block px-3 py-1 text-[10px] text-muted-foreground">
              Worktree operation in progress.
            </span>
          ) : null}
          <ModeMenuBody mode={mode} />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="workspace-bar-mode-pick-worktree"
            disabled={mode.pending}
            onSelect={mode.onOpenPicker}
          >
            <FolderSearch aria-hidden="true" className="size-3.5" />
            Use existing worktree…
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
            <span className="min-w-0 flex-1">
              <span className="block">New worktree…</span>
              {mode.createDisabledReason ? (
                <span
                  className="block whitespace-normal text-[10px] text-muted-foreground"
                  data-testid="workspace-bar-mode-create-disabled-reason"
                >
                  {mode.createDisabledReason}
                </span>
              ) : null}
            </span>
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
