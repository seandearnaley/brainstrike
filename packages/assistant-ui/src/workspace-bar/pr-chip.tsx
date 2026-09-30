import type { ForgeCheck, ForgePrStatus, ForgePullRequest } from '@brainstrike/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  CircleDot,
  ClipboardCopy,
  ExternalLink,
  Eye,
  EyeOff,
  GitPullRequest,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * Everything the chip needs, supplied by app-shell. The chip owns no state and
 * reads no store — same discipline as FolderChip/BranchChip.
 *
 * `onAskAgentToFixChecks` is `undefined` when there is no thread to insert a
 * prompt into (a brand-new, unbound composer). It inserts composer text and
 * nothing else: there is NO auto-fix loop in v1 (D5).
 */
export interface WorkspaceBarForge {
  readonly onAskAgentToFixChecks: (() => void) | undefined;
  readonly onCopyUrl: (url: string) => void;
  readonly onOpenExternal: (url: string) => void;
  readonly onRefresh: () => void;
  /**
   * `undefined` when there is no thread to persist the toggle against — the
   * Watch item is hidden entirely rather than offered as an action that can
   * only fail with a toast (BST-1391 fix round, L4).
   */
  readonly onWatchChange: ((watched: boolean) => void) | undefined;
  readonly status: ForgePrStatus;
  readonly watched: boolean;
}

function checkGlyph(conclusion: ForgeCheck['conclusion']): string {
  switch (conclusion) {
    case 'action_required':
      return '!';
    case 'cancelled':
    case 'failure':
    case 'timed_out':
      return '✗';
    case 'neutral':
    case 'skipped':
      return '–';
    case 'pending':
      return '◐';
    case 'success':
      return '✓';
  }
}

/** The compact status cluster: state first, then the checks rollup. */
function summarize(pullRequest: ForgePullRequest): {
  readonly glyph: string;
  readonly text: string;
} {
  if (pullRequest.state === 'merged') {
    return { glyph: '⏻', text: 'merged' };
  }
  if (pullRequest.state === 'closed') {
    return { glyph: '⏻', text: 'closed' };
  }
  if (pullRequest.isDraft) {
    return { glyph: '◌', text: 'draft' };
  }
  const failing = pullRequest.checks.filter(
    (check) =>
      check.conclusion === 'action_required' ||
      check.conclusion === 'cancelled' ||
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out'
  ).length;
  if (pullRequest.checksRollup === 'failing') {
    return { glyph: '✗', text: `${failing} failing` };
  }
  if (pullRequest.checksRollup === 'pending') {
    return { glyph: '◐', text: 'checks' };
  }
  if (pullRequest.checksRollup === 'none') {
    return { glyph: '·', text: 'no checks' };
  }
  return { glyph: '✓', text: `${pullRequest.checks.length}/${pullRequest.checks.length}` };
}

function reviewLabel(decision: NonNullable<ForgePullRequest['reviewDecision']>): string {
  switch (decision) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes requested';
    case 'REVIEW_REQUIRED':
      return 'Review required';
  }
}

/**
 * The composer's PR chip (spec §4.4). Present ONLY when there is a pull
 * request to describe: an `unavailable` status renders nothing here and states
 * its reason in the BranchChip's forge diagnostic instead, a `none` status is
 * an ordinary "this branch has no PR" with nothing to show, and an `unknown`
 * status (no observation yet) renders nothing either — same silence as
 * `none`, but a different fact (see the Design decisions section above).
 *
 * A `stale` status renders the last-known PR with `data-stale="true"` and puts
 * the failure in the popover — never a fresh-looking chip over a failed
 * refresh (spec §13). `stale.pullRequest` is `null` when the last known
 * observation was ITSELF a `none` (gh had already reported no pull request
 * before this refresh started failing): there is no PR to describe, so this
 * renders the same nothing as `unavailable`/`none` rather than dereferencing a
 * null `pullRequest` — an unavailable-flavored render, never a crash.
 */
export const PrChip = ({ forge }: { readonly forge: WorkspaceBarForge }): ReactElement | null => {
  const { status } = forge;
  if (
    status.kind === 'none' ||
    status.kind === 'unavailable' ||
    status.kind === 'unknown' ||
    status.pullRequest === null
  ) {
    return null;
  }
  const { pullRequest } = status;
  const stale = status.kind === 'stale';
  const { onWatchChange } = forge;
  const summary = summarize(pullRequest);
  const label = `Pull request #${pullRequest.number}: ${summary.text}${stale ? ' (last known — refresh failed)' : ''}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground"
        data-checks={pullRequest.checksRollup}
        data-stale={stale ? 'true' : 'false'}
        data-testid="workspace-bar-pr-chip"
        title={label}
        type="button"
      >
        <GitPullRequest aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0 tabular-nums">{`#${pullRequest.number}`}</span>
        <span aria-hidden="true" className="shrink-0">
          {summary.glyph}
        </span>
        <span className="truncate">{summary.text}</span>
        {stale ? (
          <span className="shrink-0 text-warning" data-testid="workspace-bar-pr-stale-glyph">
            ◌
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="truncate">{pullRequest.title}</DropdownMenuLabel>
        <div className="px-2 pb-1 text-[11px] text-muted-foreground">
          {pullRequest.state === 'open' && pullRequest.isDraft ? 'Draft' : pullRequest.state}
          {pullRequest.reviewDecision ? ` · ${reviewLabel(pullRequest.reviewDecision)}` : ''}
        </div>
        {stale ? (
          <div
            className="px-2 pb-2 text-[11px] text-destructive"
            data-testid="workspace-bar-pr-error"
          >
            {status.failure.detail}
          </div>
        ) : null}
        <DropdownMenuSeparator />
        {pullRequest.checks.length > 0 ? (
          <div className="max-h-48 overflow-y-auto py-1">
            {pullRequest.checks.map((check, index) => {
              const url = check.url;
              // Duplicate check names are real (matrix jobs, cross-workflow
              // same name), so the name alone cannot key this list below.
              // These rows are stateless (no inputs, no internal state to
              // mismatch across a reorder), so the index-as-key concern does
              // not apply — the position prefix only disambiguates.
              const rowKey = `${index}-${check.name}`;
              return (
                <div
                  className="flex items-center gap-2 px-2 py-0.5 text-[11px]"
                  data-testid={`workspace-bar-pr-check-${check.name}`}
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- stateless row; name alone collides on duplicate check names (matrix jobs), the position prefix only disambiguates
                  key={rowKey}
                >
                  <span aria-hidden="true" className="w-3 shrink-0 text-center">
                    {checkGlyph(check.conclusion)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{check.name}</span>
                  {url ? (
                    <button
                      className="shrink-0 text-muted-foreground underline"
                      onClick={() => forge.onOpenExternal(url)}
                      type="button"
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            No checks reported for this pull request.
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="workspace-bar-pr-open-external"
          onSelect={() => forge.onOpenExternal(pullRequest.url)}
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
          Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="workspace-bar-pr-copy-url"
          onSelect={() => forge.onCopyUrl(pullRequest.url)}
        >
          <ClipboardCopy aria-hidden="true" className="size-3.5" />
          Copy URL
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="workspace-bar-pr-refresh" onSelect={forge.onRefresh}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Refresh
        </DropdownMenuItem>
        {onWatchChange ? (
          <DropdownMenuItem
            data-testid="workspace-bar-pr-watch"
            onSelect={() => onWatchChange(!forge.watched)}
          >
            {forge.watched ? (
              <EyeOff aria-hidden="true" className="size-3.5" />
            ) : (
              <Eye aria-hidden="true" className="size-3.5" />
            )}
            {forge.watched ? 'Stop watching checks' : 'Watch checks'}
          </DropdownMenuItem>
        ) : null}
        {pullRequest.checksRollup === 'failing' && forge.onAskAgentToFixChecks ? (
          <DropdownMenuItem
            data-testid="workspace-bar-pr-fix-checks"
            onSelect={forge.onAskAgentToFixChecks}
          >
            <Wrench aria-hidden="true" className="size-3.5" />
            Ask the agent to fix failing checks
          </DropdownMenuItem>
        ) : null}
        <div className="flex items-center gap-1 px-2 pt-1 text-[10px] text-muted-foreground">
          <CircleDot aria-hidden="true" className="size-2.5" />
          {`Observed ${new Date(status.observedAt).toLocaleTimeString()}`}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

PrChip.displayName = 'PrChip';
