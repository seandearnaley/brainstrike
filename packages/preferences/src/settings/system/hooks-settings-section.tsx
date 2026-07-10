/**
 * Hooks trust-approval settings panel (tool-lifecycle hooks security spine).
 *
 * Lists the global hooks config path and each mounted root's project-hook
 * status (trusted / untrusted / changed / parse-error), with Approve (pinned to
 * the file's current SHA-256) and Revoke actions. The renderer only ATTESTS
 * approvals; the assistant server re-hashes disk on every request. Full editing
 * of `hooks.json` is a follow-up (view + approve only in v1).
 */

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
import { hookTrustSelectors, useHookTrustStore } from '../../stores/hook-trust-store';

export interface HookReviewRoot {
  readonly absPath: string;
  readonly displayName: string;
  readonly rootId: string;
}

interface ProjectHooksReview {
  readonly content?: string;
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

type RootStatus = 'no-file' | 'untrusted' | 'trusted' | 'changed' | 'parse-error' | 'error';

function resolveStatus(
  review: ProjectHooksReview | undefined,
  approvedSha256: string | undefined
): RootStatus {
  if (!review) {
    return 'untrusted';
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
  error: 'Unavailable',
  'no-file': 'No hooks file',
  'parse-error': 'Config error',
  trusted: 'Trusted',
  untrusted: 'Untrusted',
};

const STATUS_VARIANT: Record<RootStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  changed: 'destructive',
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
  // Canonical data-fetch-in-effect: an `ignore` flag drops a stale response if
  // the roots change (or the panel unmounts) before the fetch resolves. Each
  // root is fetched independently and its own transport failure is converted to
  // a structured `error` review, so a single broken bridge call renders that ONE
  // row as "Unavailable" rather than leaving every row in a stale/empty state.
  useEffect(() => {
    const bridge = getHooksBridge();
    if (!bridge) {
      return;
    }
    let ignore = false;
    // Each root's fetch resolves (transport failures are caught into an `error`
    // review below), so this chain never rejects from the bridge; `void` marks it
    // intentionally floating without swallowing a genuine setState/render throw.
    void Promise.all(
      roots.map(async (root): Promise<readonly [string, ProjectHooksReview]> => {
        try {
          const review = await bridge.getProjectHooksForReview(root.rootId, root.absPath);
          return [root.rootId, review] as const;
        } catch (error) {
          return [
            root.rootId,
            {
              error: error instanceof Error ? error.message : 'Failed to read project hooks',
              exists: false,
              path: `${root.absPath}/.brainstrike/hooks.json`,
              rootId: root.rootId,
            },
          ] as const;
        }
      })
    ).then((entries) => {
      if (!ignore) {
        setReviews(Object.fromEntries(entries));
      }
    });
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
              const approved = approvalsByRootId[root.rootId];
              const status = resolveStatus(review, approved?.sha256);
              const canApprove =
                review?.exists === true && !review.parseError && Boolean(review.sha256);
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
                    {status === 'trusted' ? (
                      <Button
                        data-testid={`hooks-revoke-${root.rootId}`}
                        onClick={() => revokeRoot(root.rootId)}
                        size="sm"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        data-testid={`hooks-approve-${root.rootId}`}
                        disabled={!canApprove}
                        onClick={() => {
                          if (review?.sha256) {
                            approveRoot(root.rootId, review.sha256);
                          }
                        }}
                        size="sm"
                      >
                        Approve
                      </Button>
                    )}
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
