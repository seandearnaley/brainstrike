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

/**
 * Local / Worktree [D1]. "Cloud" is deliberately absent, not a disabled row:
 * there is no environment story to explain, and the omit-don't-stub convention
 * applies to a mode exactly as it does to a bridge.
 *
 * The create dialog lives INSIDE this component's JSX because dialog nesting
 * depth is LEXICAL (`ui-conventions.md`): hoisting it would drop it to tier 1
 * and paint its scrim under the chip's own popup.
 *
 * "Use an existing worktree…" opens `mode.onOpenPicker` (owned by app-shell);
 * the picker dialog itself lands in a follow-up task and is not rendered here.
 */
export const ModeChip = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const [createOpen, setCreateOpen] = useState(false);
  const { worktree } = mode;
  const label = worktree ? `⧉ ${worktree.name}` : 'Local';
  const title =
    mode.disabledReason ??
    (worktree ? worktree.path : `Edits land in ${mode.localPath ?? 'this folder'}`);

  if (mode.disabledReason) {
    return (
      <button
        aria-label={`Checkout mode unavailable: ${mode.disabledReason}`}
        className={CHIP_CLASSES}
        data-testid="workspace-bar-mode-chip"
        disabled
        title={mode.disabledReason}
        type="button"
      >
        <Layers aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">Local</span>
      </button>
    );
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
          <ModeMenuBody mode={mode} />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="workspace-bar-mode-new-worktree"
            disabled={mode.pending}
            onSelect={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            New worktree…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorktreeCreateDialog mode={mode} onOpenChange={setCreateOpen} open={createOpen} />
    </>
  );
};

ModeChip.displayName = 'ModeChip';
