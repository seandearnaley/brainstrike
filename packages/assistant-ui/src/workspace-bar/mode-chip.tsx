import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { Archive, ChevronDown, FolderOpen, GitBranchPlus, Home, Layers, Plus } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type { WorkspaceBarMode, WorkspaceBarWorktreeSummary } from './workspace-bar';
import { WorktreeCreateDialog } from './worktree-create-dialog';

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
        className="mt-1 block text-[10px] text-amber-700 leading-snug dark:text-amber-300"
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
        onSelect={() => mode.onCreateBranchHere?.(`${mode.defaultBranchPrefix}${worktree.name}`)}
      >
        <GitBranchPlus aria-hidden="true" className="size-3.5" />
        Create branch here
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
      <span className="shrink-0 text-amber-600 dark:text-amber-400">!</span>
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
 * The create dialog lives INSIDE this component's JSX because dialog nesting
 * depth is LEXICAL (`ui-conventions.md`): hoisting it would drop it to tier 1
 * and paint its scrim under the chip's own popup.
 *
 * `mode.onOpenPicker` is reserved for a follow-up task's "Use an existing
 * worktree…" picker and is intentionally not wired to a menu item yet.
 */
export const ModeChip = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const [createOpen, setCreateOpen] = useState(false);
  const { worktree } = mode;
  const label = worktree ? worktree.name : 'Local';
  const title =
    mode.disabledReason ??
    (worktree ? worktree.path : `Edits land in ${mode.localPath ?? 'this folder'}`);

  if (mode.disabledReason) {
    return <DiagnosticOnlyModeChip label={label} mode={mode} reason={mode.disabledReason} />;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={worktree ? `Worktree: ${worktree.name}` : 'Checkout mode: Local'}
          className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
          data-setup={worktree?.setupStatus ?? 'none'}
          data-testid="workspace-bar-mode-chip"
          title={title}
        >
          <Layers aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
          {worktree?.setupStatus === 'failed' ? (
            <span className="shrink-0 text-amber-600 dark:text-amber-400">!</span>
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
            className="items-start"
            data-testid="workspace-bar-mode-new-worktree"
            disabled={mode.pending || mode.createDisabledReason !== null}
            onSelect={() => setCreateOpen(true)}
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
        <WorktreeCreateDialog mode={mode} onOpenChange={setCreateOpen} open={createOpen} />
      ) : null}
    </>
  );
};

ModeChip.displayName = 'ModeChip';
