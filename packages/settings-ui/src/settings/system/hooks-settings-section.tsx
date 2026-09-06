/**
 * Hooks trust-approval settings panel (tool-lifecycle hooks security spine).
 *
 * Lists the global hooks config path and each mounted root's project-hook
 * status (trusted / untrusted / changed / parse-error), with Approve (pinned to
 * the file's current SHA-256) and Revoke actions. The renderer only ATTESTS
 * approvals; the assistant server re-hashes disk on every request. Approval is
 * SHA-256-only in v1 — the panel does not yet render the file's contents; an
 * in-panel content view and full `hooks.json` editing are documented follow-ups.
 */

import {
  hookTrustSelectors,
  useHookTrustStore,
} from '@brainstrike/app-state/stores/hook-trust-store';
import { createLogger } from '@brainstrike/logging';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@brainstrike/ui';
import { useEffect, useState } from 'react';

const logger = createLogger('HooksSettings');

export interface HookReviewRoot {
  readonly absPath: string;
  readonly displayName: string;
  readonly rootId: string;
}

interface ProjectHooksReview {
  readonly content?: string;
  /**
   * The DB `roots.id` main resolved for this root's path. The trust store is
   * keyed by THIS id (stable across remove/re-add), not the ephemeral adapter
   * id the panel fetches by. Absent when the path resolves to no mounted DB root
   * (then the row cannot be trusted/approved — fail closed).
   */
  readonly dbRootId?: string;
  readonly error?: string;
  readonly exists: boolean;
  readonly parseError?: string;
  readonly path: string;
  readonly rootId: string;
  readonly sha256?: string;
}

interface HooksBridge {
  readonly getProjectHooksForReview: (
    rootId: string,
    absPath: string
  ) => Promise<ProjectHooksReview>;
}

function getHooksBridge(): HooksBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { hooks?: HooksBridge }).hooks;
  return bridge ?? null;
}

export interface HooksSettingsSectionProps {
  /** Global config path label (e.g. `~/.brainstrike/hooks.json`). */
  readonly globalConfigPath?: string;
  /** Mounted desktop roots to review. Empty on web / before roots resolve. */
  readonly roots?: readonly HookReviewRoot[];
}

type RootStatus =
  | 'checking'
  | 'no-file'
  | 'untrusted'
  | 'trusted'
  | 'changed'
  | 'parse-error'
  | 'error';

function resolveStatus(
  review: ProjectHooksReview | undefined,
  approvedSha256: string | undefined
): RootStatus {
  if (!review) {
    // Fetch still in flight: never render the security-meaningful "Untrusted"
    // badge as a placeholder — show a neutral checking state instead.
    return 'checking';
  }
  if (review.error) {
    return 'error';
  }
  if (!review.exists) {
    return 'no-file';
  }
  if (review.parseError) {
    return 'parse-error';
  }
  if (!approvedSha256) {
    return 'untrusted';
  }
  return approvedSha256 === review.sha256 ? 'trusted' : 'changed';
}

const STATUS_LABEL: Record<RootStatus, string> = {
  changed: 'Changed — re-approve',
  checking: 'Checking…',
  error: 'Unavailable',
  'no-file': 'No hooks file',
  'parse-error': 'Config error',
  trusted: 'Trusted',
  untrusted: 'Untrusted',
};

const STATUS_VARIANT: Record<RootStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  changed: 'destructive',
  checking: 'outline',
  error: 'outline',
  'no-file': 'outline',
  'parse-error': 'destructive',
  trusted: 'default',
  untrusted: 'secondary',
};

const EMPTY_ROOTS: readonly HookReviewRoot[] = [];

export function HooksSettingsSection({
  roots = EMPTY_ROOTS,
  globalConfigPath = '~/.brainstrike/hooks.json',
}: HooksSettingsSectionProps) {
  const approvalsByRootId = useHookTrustStore(hookTrustSelectors.approvalsByRootId);
  const approveRoot = useHookTrustStore((state) => state.approveRoot);
  const revokeRoot = useHookTrustStore((state) => state.revokeRoot);
  const [reviews, setReviews] = useState<Record<string, ProjectHooksReview>>({});

  // Fetch each root's on-disk review (content + hash) from the desktop bridge.
  // Canonical data-fetch-in-effect: an `ignore` flag drops stale responses if the
  // roots change (or the panel unmounts) before a fetch resolves. Each root
  // SETTLES INDEPENDENTLY (per-row `setReviews` merge, not one `Promise.all`), so
  // a single slow/hung root never starves the others' status; a row with no
  // review yet renders a neutral "Checking…" state, never a placeholder
  // "Untrusted". A per-root transport failure is converted to a structured
  // `error` review so that ONE row renders "Unavailable".
  useEffect(() => {
    const bridge = getHooksBridge();
    if (!bridge) {
      return;
    }
    let ignore = false;
    // No synchronous reset: rows render by iterating `roots`, so a removed
    // root's stale review is simply never shown (and adapter ids are fresh per
    // mount, so an id never recurs with a stale entry).
    for (const root of roots) {
      bridge
        .getProjectHooksForReview(root.rootId, root.absPath)
        .then((review) => {
          if (!ignore) {
            setReviews((prev) => ({ ...prev, [root.rootId]: review }));
          }
        })
        .catch((error: unknown) => {
          // A wedged/broken bridge is hard to debug from the "Unavailable" badge
          // alone — log the transport failure alongside the honest UI surfacing.
          logger.warn('Failed to read project hooks for review', {
            error: error instanceof Error ? error.message : String(error),
            rootId: root.rootId,
          });
          if (!ignore) {
            setReviews((prev) => ({
              ...prev,
              [root.rootId]: {
                error: error instanceof Error ? error.message : 'Failed to read project hooks',
                exists: false,
                path: `${root.absPath}/.brainstrike/hooks.json`,
                rootId: root.rootId,
              },
            }));
          }
        });
    }
    return () => {
      ignore = true;
    };
  }, [roots]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hooks</CardTitle>
        <CardDescription>
          Approve a workspace’s <code>.brainstrike/hooks.json</code> before its shell hooks run.
          Approvals are pinned to the file’s exact contents — editing the file requires re-approval.
          Global hooks at <code>{globalConfigPath}</code> run without approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {roots.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="hooks-no-roots">
            No workspace roots are mounted. Open a workspace to review its project hooks.
          </p>
        ) : (
          <ul className="space-y-3">
            {roots.map((root) => {
              const review = reviews[root.rootId];
              // Trust is keyed by the DB root id (resolved by main), NOT the
              // adapter id this row is fetched under — the two diverge after a
              // remove→re-add, and keying by the adapter id is the fail-open the
              // security spine must never allow.
              const dbRootId = review?.dbRootId;
              const approved = dbRootId ? approvalsByRootId[dbRootId] : undefined;
              const status = resolveStatus(review, approved?.sha256);
              const canApprove =
                review?.exists === true &&
                !review.parseError &&
                Boolean(review.sha256) &&
                Boolean(dbRootId);
              // While the review is in flight the row has NO actionable state, so
              // it renders no action control — same reasoning as the neutral
              // "Checking…" badge. A placeholder Approve button here would be a
              // control that silently does nothing when pressed: React drops click
              // listeners on disabled buttons, so the press is swallowed rather
              // than queued, and the row then settles into an enabled Approve that
              // looks as though it was never touched.
              const showRevoke = status === 'trusted';
              const showApprove = status !== 'trusted' && status !== 'checking';
              return (
                <li
                  className="flex items-center justify-between gap-4 rounded-md border p-3"
                  data-testid={`hooks-root-${root.rootId}`}
                  key={root.rootId}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-sm">{root.displayName}</p>
                    <p className="truncate text-muted-foreground text-xs">
                      {review?.path ?? `${root.absPath}/.brainstrike/hooks.json`}
                    </p>
                    {review?.parseError ? (
                      <p className="text-destructive text-xs">{review.parseError}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
                    {showRevoke ? (
                      <Button
                        data-testid={`hooks-revoke-${root.rootId}`}
                        onClick={() => {
                          if (dbRootId) {
                            revokeRoot(dbRootId);
                          }
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    ) : null}
                    {showApprove ? (
                      <Button
                        data-testid={`hooks-approve-${root.rootId}`}
                        disabled={!canApprove}
                        onClick={() => {
                          if (review?.sha256 && dbRootId) {
                            approveRoot(dbRootId, review.sha256);
                          }
                        }}
                        size="sm"
                      >
                        Approve
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
