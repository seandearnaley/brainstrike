/**
 * One checkout card in the Worktree Map (spec §10). Pure: every action arrives
 * as a prop and every fact arrives on the model, so the surface owns all
 * context and this file owns only presentation.
 */
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  Check,
  Circle,
  Database,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  TerminalSquare,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorktreeCheckoutStatusState } from './use-worktree-checkout-status';
import type { WorktreeMapCardModel } from './worktree-map-model';

export interface WorktreeMapCardProps {
  readonly card: WorktreeMapCardModel;
  readonly onAddAsRoot: (card: WorktreeMapCardModel) => void;
  /** Present on every card; enabled only for `!entry.managed` (spec §10 "Add as root" / A7). */
  readonly onAdopt: (card: WorktreeMapCardModel) => void;
  readonly onArchive: (card: WorktreeMapCardModel) => void;
  /** Present only for the card holding the SELECTED thread's checkout [A11]. */
  readonly onHandOffToLocal?: (() => void) | undefined;
  readonly onNewThread: (card: WorktreeMapCardModel) => void;
  readonly onOpenPullRequest: (url: string) => void;
  /**
   * Present only when the platform HAS a terminal bridge (desktop). Absent on
   * web, where the item must not exist in any form.
   */
  readonly onOpenTerminal: ((card: WorktreeMapCardModel) => void) | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onToggleIndexing: (rootId: string, enabled: boolean) => void;
  readonly status: WorktreeCheckoutStatusState | undefined;
}

function StatusGlyphs({ status }: { readonly status: WorktreeCheckoutStatusState | undefined }) {
  if (!status || status.kind === 'loading') {
    // Never a clean glyph before the read resolves: "clean" is a claim, and we
    // do not have it yet.
    return <span className="text-muted-foreground text-xs">checking…</span>;
  }
  if (status.kind === 'error') {
    return (
      <span className="min-w-0 max-w-full break-words text-destructive text-xs">
        status unavailable: {status.message}
      </span>
    );
  }
  const { ahead, behind, clean } = status.value;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
      {clean ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Check aria-hidden="true" className="size-3.5" />
          Clean
        </span>
      ) : (
        <span
          aria-label="Uncommitted changes"
          className="inline-flex items-center gap-1.5 text-warning"
          role="img"
          title="Uncommitted changes"
        >
          <Circle aria-hidden="true" className="size-2 fill-current" />
          Modified
        </span>
      )}
      {ahead ? (
        <span aria-label={`${ahead} commits ahead of upstream`} role="img">
          ↑{ahead}
        </span>
      ) : null}
      {behind ? (
        <span aria-label={`${behind} commits behind upstream`} role="img">
          ↓{behind}
        </span>
      ) : null}
    </span>
  );
}

function WorktreeThreadDetails({
  card,
  current,
  onOpenThread,
}: Pick<WorktreeMapCardProps, 'card' | 'onOpenThread'> & {
  readonly current: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {card.thread ? (
        <Button
          className="h-7 max-w-full justify-start gap-1.5 px-0 text-xs"
          onClick={() => onOpenThread(card.thread?.threadId ?? '')}
          title={card.thread.title}
          type="button"
          variant="ghost"
        >
          {card.thread.running ? (
            <span
              aria-label="Running"
              className="size-1.5 shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-400"
              role="img"
              title="Thread is running"
            />
          ) : (
            <MessageSquare aria-hidden="true" className="size-3.5" />
          )}
          <span className="truncate">{card.thread.title}</span>
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">No linked thread</span>
      )}
      {current ? <span className="text-[10px] text-primary">Current thread</span> : null}
      {card.lastActivityLabel ? (
        <p className="text-[10px] text-muted-foreground">{card.lastActivityLabel}</p>
      ) : null}
    </div>
  );
}

function WorktreeIndexingToggle({
  card,
  onToggleIndexing,
}: Pick<WorktreeMapCardProps, 'card' | 'onToggleIndexing'>): ReactElement {
  const { entry } = card;
  const indexingEnabled = card.indexing === 'included';
  return card.indexing === 'not-a-root' ? (
    <span aria-hidden="true" className="size-8 shrink-0" />
  ) : (
    <Button
      aria-label={indexingEnabled ? 'Indexing enabled' : 'Not indexed'}
      aria-pressed={indexingEnabled}
      className={indexingEnabled ? 'text-primary' : 'text-muted-foreground'}
      data-testid="worktree-map-indexing"
      onClick={() => {
        if (entry.rootId) {
          onToggleIndexing(entry.rootId, !indexingEnabled);
        }
      }}
      size="icon-sm"
      title={
        indexingEnabled ? 'Indexing enabled — click to exclude' : 'Not indexed — click to include'
      }
      type="button"
      variant="ghost"
    >
      <Database aria-hidden="true" className="size-3.5" />
    </Button>
  );
}

export function WorktreeMapCard({
  card,
  onAddAsRoot,
  onAdopt,
  onArchive,
  onHandOffToLocal,
  onNewThread,
  onOpenPullRequest,
  onOpenTerminal,
  onOpenThread,
  onReveal,
  onToggleIndexing,
  status,
}: WorktreeMapCardProps): ReactElement {
  const { entry } = card;
  return (
    <article
      aria-label={entry.name}
      className="grid min-w-0 @min-[600px]/worktrees:grid-cols-2 @min-[760px]/worktrees:grid-cols-[minmax(0,1fr)_8.5rem_11rem_12rem] grid-cols-1 items-center gap-3 border-l-2 border-l-transparent bg-card px-3 py-3 transition-colors focus-within:bg-accent/30 hover:bg-accent/30 data-[current=true]:border-l-primary data-[current=true]:bg-primary/5"
      data-current={onHandOffToLocal ? 'true' : undefined}
      data-testid="worktree-map-card"
    >
      <div className="min-w-0">
        <header className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate font-medium text-sm" title={entry.name}>
            {entry.name}
          </h3>
          <Badge
            className="shrink-0 px-1.5 py-0 text-[10px]"
            data-testid="worktree-map-provenance"
            variant="outline"
          >
            {card.provenanceLabel}
          </Badge>
        </header>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
          <span
            className="truncate font-mono text-[11px]"
            data-testid="worktree-map-branch"
            title={card.branchLabel}
          >
            {card.branchLabel}
          </span>
        </div>
        <p className="mt-1 truncate text-[10px] text-muted-foreground" title={entry.path}>
          {entry.path}
        </p>
        {card.disabledReason ? (
          <p
            className="mt-1 break-words text-muted-foreground text-xs"
            data-testid="worktree-map-disabled-reason"
          >
            {card.disabledReason}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 @min-[760px]/worktrees:flex-col flex-wrap @min-[760px]/worktrees:items-start items-center gap-2">
        {entry.provenance === 'agent-reported' ? (
          <span className="text-muted-foreground text-xs">Not on disk</span>
        ) : (
          <StatusGlyphs status={status} />
        )}
        {card.pullRequest ? (
          <Button
            className="h-7 max-w-full justify-start gap-1.5 px-1.5 text-xs"
            onClick={() => onOpenPullRequest(card.pullRequest?.url ?? '')}
            type="button"
            variant="ghost"
          >
            <GitPullRequest aria-hidden="true" className="size-3.5" />#{card.pullRequest.number}{' '}
            {card.pullRequest.checksRollup}
          </Button>
        ) : null}
      </div>
      <WorktreeThreadDetails
        card={card}
        current={onHandOffToLocal !== undefined}
        onOpenThread={onOpenThread}
      />
      <footer className="flex min-w-0 items-center justify-end gap-1.5">
        <WorktreeIndexingToggle card={card} onToggleIndexing={onToggleIndexing} />
        <Button
          className="h-8 min-w-0 @min-[760px]/worktrees:flex-none flex-1 shrink px-2 text-xs"
          data-testid="worktree-map-new-thread"
          disabled={!entry.usable}
          onClick={() => onNewThread(card)}
          size="sm"
          title={card.disabledReason ?? 'New thread here'}
          type="button"
          variant="outline"
        >
          <span className="truncate">New thread here</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Actions for ${entry.name}`}
              data-testid="worktree-map-card-actions"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {card.thread ? (
              <DropdownMenuItem onSelect={() => onOpenThread(card.thread?.threadId ?? '')}>
                Open thread
              </DropdownMenuItem>
            ) : null}
            {onHandOffToLocal ? (
              <DropdownMenuItem onSelect={onHandOffToLocal}>Hand off to Local</DropdownMenuItem>
            ) : null}
            {entry.rootId === null ? (
              <DropdownMenuItem onSelect={() => onAddAsRoot(card)}>Add as root</DropdownMenuItem>
            ) : null}
            {/*
              An unmanaged card is not "refused" — Adopt is its own ENABLED
              action (spec §10 "Add as root" / A7), the only surface that ever
              calls `worktrees.adopt` for real: the Mode chip's picker never
              could (every unmanaged row is `usable: false`, so its select
              button stays disabled — see A1's correction). New thread here
              stays present-but-disabled until this card is adopted (its
              `disabled={!entry.usable}` above); Archive… is ABSENT from the
              menu entirely until then (`entry.managed ? ... : null` below) —
              nothing here is silently skipped, one is greyed out and the
              other doesn't apply yet.

              `entry.primary` is EXCLUDED here too (bot review fix, PR #2664):
              the service unconditionally refuses adopting the repository's
              primary checkout (`worktree-adopt.ts`'s
              "...use Hand off to Local instead" gate), so offering Adopt on
              a primary card would be a guaranteed error, never a real
              action.
            */}
            {entry.managed || entry.primary ? null : (
              <DropdownMenuItem onSelect={() => onAdopt(card)}>Adopt</DropdownMenuItem>
            )}
            {/*
              Complementary with "Add as root" above, never both: a checkout
              with no containing root has nothing to authorize a shell, and
              "Add as root" IS the stated next step. `entry.rootId` is the
              CONTAINING root (see `rootIdIsExactMount` in
              packages/types/src/worktree.ts) while `entry.path` is the
              checkout itself — main pins the shell to the path after a
              containment check, which is why both travel.
            */}
            {onOpenTerminal && entry.rootId ? (
              <DropdownMenuItem
                data-testid="worktree-map-open-terminal"
                onSelect={() => onOpenTerminal(card)}
              >
                <TerminalSquare aria-hidden="true" className="size-3.5" />
                Open in Terminal
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => onReveal(entry.path)}>Reveal</DropdownMenuItem>
            {entry.managed ? (
              <DropdownMenuItem onSelect={() => onArchive(card)}>Archive…</DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
    </article>
  );
}
