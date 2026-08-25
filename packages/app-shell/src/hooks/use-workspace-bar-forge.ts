/**
 * The workspace bar's forge (PR) wiring — split out of `use-workspace-bar.ts`
 * (BST-1391 fix round) once that hook crossed the repo's 1000-line file cap
 * (biome's `noExcessiveLinesPerFile`). Owns the live `useThreadForgePr` read,
 * the PR chip's action handlers (open external, copy URL, refresh, watch
 * toggle, ask-agent-to-fix-checks), and the `WorkspaceBarForge` object those
 * handlers assemble into.
 *
 * M2 (opus review): `primaryRootId` is only ever passed through to
 * `useThreadForgePr` when `checkout` is defined, i.e. the primary root is a
 * CONFIRMED git repository. A non-repository root has no branch for `gh` to
 * describe, so probing forge for one would only manufacture a diagnostic
 * with nowhere to render — the BranchChip is that diagnostic's only home
 * (`workspace-bar.tsx`), and the BranchChip itself requires `checkout`. Same
 * discipline `useBranchSwitcher` applies by gating its returned menu on
 * `checkout` (see its doc comment) — principled silence, not a dropped
 * observation.
 */
import type {
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from '@brainstrike/assistant-data';
import type { WorkspaceBarCheckout, WorkspaceBarForge } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import type { PlatformBridge } from '../platform-bridge';
import { useThreadForgePr } from './use-thread-forge-pr';
import { copyWorkspaceBarValue } from './workspace-bar-clipboard';

const logger = createLogger('WorkspaceBarForge');

type UpdateThreadMetadata = (
  repository: AssistantThreadRepository,
  resourceId: string,
  threadId: string,
  metadata: AssistantThreadMetadata
) => Promise<void>;

export interface UseWorkspaceBarForgeArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  /** Gates whether forge is probed at all — see the M2 doc above. */
  readonly checkout: WorkspaceBarCheckout | undefined;
  readonly forgePrWatched: boolean;
  readonly memoryResourceId: string;
  readonly platform: PlatformBridge | null;
  readonly primaryRootId: string | null;
  readonly selectedMemoryThreadId: string | undefined;
  readonly updateThreadMetadata: UpdateThreadMetadata;
}

export function useWorkspaceBarForge(
  args: UseWorkspaceBarForgeArgs
): WorkspaceBarForge | undefined {
  const {
    assistantThreadRepository,
    checkout,
    forgePrWatched,
    memoryResourceId,
    platform,
    primaryRootId,
    selectedMemoryThreadId,
    updateThreadMetadata,
  } = args;

  // See the module doc (M2): a non-repository primary root asks gh nothing.
  const forgePr = useThreadForgePr(checkout ? primaryRootId : null);

  const onOpenExternal = useCallback(
    (url: string): void => {
      if (!platform) {
        logger.error('Open pull request requested without the platform capability', { url });
        toast({
          description: 'This platform cannot open the pull request URL.',
          title: 'Open pull request failed',
          variant: 'destructive',
        });
        return;
      }
      void platform
        .openExternal(url)
        .then((outcome) => {
          if (outcome.ok) {
            return;
          }
          const detail = outcome.error ?? 'The platform did not open the pull request URL.';
          logger.error('Open pull request failed', { error: detail, url });
          toast({
            description: detail,
            title: 'Open pull request failed',
            variant: 'destructive',
          });
        })
        .catch((error: unknown) => {
          logger.error('Open pull request failed', { error, url });
          toast({
            description: error instanceof Error ? error.message : String(error),
            title: 'Open pull request failed',
            variant: 'destructive',
          });
        });
    },
    [platform]
  );

  const onCopyUrl = useCallback((url: string) => {
    copyWorkspaceBarValue(url, 'url');
  }, []);

  // `undefined` (never a toast-only stub) when there is no thread to persist
  // the toggle against: the PR chip hides the Watch item entirely rather
  // than offering an action that can only fail (BST-1391 fix round, L4).
  const onWatchChange = useMemo(() => {
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      return;
    }
    return (watched: boolean): void => {
      void updateThreadMetadata(
        assistantThreadRepository,
        memoryResourceId,
        selectedMemoryThreadId,
        { forgePrWatch: watched }
      ).catch((error: unknown) => {
        logger.error('Update PR watch state failed', { error, watched });
        toast({
          description: error instanceof Error ? error.message : String(error),
          title: 'PR watch setting was not updated',
          variant: 'destructive',
        });
      });
    };
  }, [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]);

  const askAgentToFixChecks = useMemo(() => {
    const status = forgePr.status;
    if (!(selectedMemoryThreadId && status)) {
      return;
    }
    if (status.kind !== 'pr' && status.kind !== 'stale') {
      return;
    }
    const { pullRequest } = status;
    if (pullRequest === null) {
      return;
    }
    // Single pass, matching the `buildBranchSwitchModel` precedent — a
    // chained `.filter().map()` walked the checks list twice for no reason
    // (BST-1391 fix round, F5).
    const failing: string[] = [];
    for (const check of pullRequest.checks) {
      if (
        check.conclusion === 'action_required' ||
        check.conclusion === 'cancelled' ||
        check.conclusion === 'failure' ||
        check.conclusion === 'timed_out'
      ) {
        failing.push(check.name);
      }
    }
    return (): void => {
      // Prompt insertion only — the user can inspect and edit it before send.
      useAssistantComposerCommandStore.getState().enqueue({
        mode: 'append',
        text: `Pull request #${pullRequest.number} (${pullRequest.url}) has failing checks: ${failing.join(', ')}. Investigate why each one failed and propose a fix.`,
        threadId: selectedMemoryThreadId,
      });
    };
  }, [forgePr.status, selectedMemoryThreadId]);

  return useMemo<WorkspaceBarForge | undefined>(() => {
    if (forgePr.status === null) {
      return forgePr.diagnostic
        ? {
            onAskAgentToFixChecks: undefined,
            onCopyUrl,
            onOpenExternal,
            onRefresh: forgePr.refresh,
            onWatchChange,
            status: {
              failure: { detail: forgePr.diagnostic, reason: 'fetch-failed' },
              kind: 'unavailable',
            },
            watched: forgePrWatched,
          }
        : undefined;
    }
    return {
      onAskAgentToFixChecks: askAgentToFixChecks,
      onCopyUrl,
      onOpenExternal,
      onRefresh: forgePr.refresh,
      onWatchChange,
      status: forgePr.status,
      watched: forgePrWatched,
    };
  }, [
    askAgentToFixChecks,
    forgePr.diagnostic,
    forgePr.refresh,
    forgePr.status,
    forgePrWatched,
    onCopyUrl,
    onOpenExternal,
    onWatchChange,
  ]);
}
