import { GitBranch } from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorkspaceBarCheckout } from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

/**
 * Read-only git state for the primary root (W1): branch (or "detached"),
 * ahead/behind counts, and a dirty dot. An interactive branch menu lands later
 * — this chip deliberately has no affordances beyond its tooltip.
 *
 * The glyph cluster (↑2 ↓1 ●) is compact by design, so the whole chip is one
 * labelled image to assistive tech: the spelled-out summary is the tooltip.
 */
export const BranchChip = ({
  checkout,
}: {
  readonly checkout: WorkspaceBarCheckout;
}): ReactElement => {
  const label = checkout.branch ?? 'detached';
  const ahead = countBadge(checkout.ahead, '↑');
  const behind = countBadge(checkout.behind, '↓');
  const summary = [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    ahead ? `${checkout.ahead} ahead` : null,
    behind ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return (
    <span
      aria-label={summary}
      className="inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground"
      data-dirty={checkout.dirty ? 'true' : 'false'}
      data-testid="workspace-bar-branch-chip"
      role="img"
      title={summary}
    >
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {ahead ? <span className="shrink-0 tabular-nums">{ahead}</span> : null}
      {behind ? <span className="shrink-0 tabular-nums">{behind}</span> : null}
      {checkout.dirty ? (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">●</span>
      ) : null}
    </span>
  );
};

BranchChip.displayName = 'BranchChip';
