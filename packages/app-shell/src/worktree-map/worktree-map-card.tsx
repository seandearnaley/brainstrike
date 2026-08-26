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
import { MoreHorizontal } from 'lucide-react';
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
    return <span className="text-destructive text-xs">status unavailable: {status.message}</span>;
  }
  const { ahead, behind, clean } = status.value;
  return (
    <span className="flex items-center gap-1 text-xs">
      {clean ? null : (
        <span aria-label="Uncommitted changes" role="img" title="Uncommitted changes">
          ●
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

export function WorktreeMapCard({
  card,
  onAddAsRoot,
  onAdopt,
  onArchive,
  onHandOffToLocal,
  onNewThread,
  onOpenPullRequest,
  onOpenThread,
  onReveal,
  onToggleIndexing,
  status,
}: WorktreeMapCardProps): ReactElement {
  const { entry } = card;
  const indexingEnabled = card.indexing === 'included';
  return (
    <article
      className="flex w-64 shrink-0 flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="worktree-map-card"
    >
      <header className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-sm" title={entry.path}>
          {entry.name}
        </span>
        <Badge variant="outline">{card.provenanceLabel}</Badge>
      </header>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-muted-foreground text-xs">{card.branchLabel}</span>
        <StatusGlyphs status={status} />
      </div>

      {card.pullRequest ? (
        <Button
          className="h-6 justify-start px-1 text-xs"
          onClick={() => onOpenPullRequest(card.pullRequest?.url ?? '')}
          type="button"
          variant="ghost"
        >
          #{card.pullRequest.number} {card.pullRequest.checksRollup}
        </Button>
      ) : null}

      {card.indexing === 'not-a-root' ? null : (
        <Button
          className="h-5 self-start px-1.5 text-[10px]"
          onClick={() => {
            if (entry.rootId) {
              onToggleIndexing(entry.rootId, !indexingEnabled);
            }
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {indexingEnabled ? 'Indexing enabled' : 'Not indexed'}
        </Button>
      )}

      {card.thread ? (
        <p className="truncate text-xs">
          {card.thread.running ? '● ' : ''}
          {card.thread.title}
        </p>
      ) : null}
      {card.lastActivityLabel ? (
        <p className="text-muted-foreground text-xs">{card.lastActivityLabel}</p>
      ) : null}

      {/* Present-but-disabled with the reason, never hidden (spec §13). */}
      {card.disabledReason ? (
        <p className="text-destructive text-xs">{card.disabledReason}</p>
      ) : null}

      <footer className="flex items-center gap-2">
        <Button
          data-testid="worktree-map-new-thread"
          disabled={!entry.usable}
          onClick={() => onNewThread(card)}
          size="sm"
          title={card.disabledReason ?? undefined}
          type="button"
        >
          New thread here
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Actions for ${entry.name}`}
              data-testid="worktree-map-card-actions"
              size="sm"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
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
            <DropdownMenuItem onSelect={() => onReveal(entry.path)}>Reveal</DropdownMenuItem>
            {entry.managed ? (
              <DropdownMenuItem onSelect={() => onArchive(card)}>Archive…</DropdownMenuItem>
            ) : null}
            {/*
              NO "Open in Terminal" ITEM. W3 ruling A6 defers the
              terminal-session seam to W6 and records "absent, not stubbed"; the
              Step-4 tripwire fails if this comment stops being true.
            */}
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
    </article>
  );
}
