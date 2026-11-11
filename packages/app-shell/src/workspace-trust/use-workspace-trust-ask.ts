import { hasFactoryResetPreparationStarted } from '@brainstrike/app-state/factory-reset';
import { useResourceThread } from '@brainstrike/assistant-data';
import type { WorkspaceBarTrust, WorkspaceBarTrustAsk } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import {
  countWorkspaceAgentConfiguration,
  describeWorkspaceAgentConfiguration,
  type WorkspaceTrustRoot,
  workspaceTrustAnswers,
} from '@brainstrike/settings-ui/settings/system/workspace-trust';
import { useEffect, useRef, useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { useWorkspaceTrustRevision } from './workspace-trust-revision';

const logger = createLogger('WorkspaceTrustAsk');

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** A folder the person has not answered for, which brings agent configuration. */
function asksForTrust(root: WorkspaceTrustRoot): boolean {
  return (
    root.trust === 'undecided' && countWorkspaceAgentConfiguration(root.agentConfiguration) > 0
  );
}

/** A thread's folders: none known until its row loads, its own, or every open one. */
type ThreadFolderIds = 'every-open-folder' | 'not-loaded' | readonly string[];

/**
 * The folders a run of the thread reads agent configuration from: its
 * binding's operating folder and secondaries, or every open folder while it
 * has no folder of its own.
 */
function threadFolderIds(thread: ReturnType<typeof useResourceThread>): ThreadFolderIds {
  if (!thread) {
    return 'not-loaded';
  }
  const operatingRootId = thread.metadata?.operatingRootId;
  return operatingRootId
    ? [operatingRootId, ...(thread.metadata?.secondaryRootIds ?? [])]
    : 'every-open-folder';
}

function threadFolders(
  roots: readonly WorkspaceTrustRoot[],
  ids: ThreadFolderIds
): readonly WorkspaceTrustRoot[] {
  if (ids === 'not-loaded') {
    return [];
  }
  return ids === 'every-open-folder' ? roots : roots.filter((root) => ids.includes(root.rootId));
}

/** One question per answer still missing, over the thread's folders that hold something. */
function trustAsks(roots: readonly WorkspaceTrustRoot[]): readonly WorkspaceBarTrustAsk[] {
  return workspaceTrustAnswers(roots.filter(asksForTrust)).map((answer) => ({
    displayName: answer.displayName,
    folders: answer.roots.map((root) => ({
      displayName: root.displayName,
      holds: describeWorkspaceAgentConfiguration(root.agentConfiguration),
      rootId: root.rootId,
    })),
    held: answer.roots.reduce(
      (total, root) => total + countWorkspaceAgentConfiguration(root.agentConfiguration),
      0
    ),
    offeredLocation: answer.offeredLocation,
    path: answer.path,
    sharedWithWorktrees: answer.sharedWithWorktrees,
  }));
}

/**
 * ADR-0032: what the composer's workspace trust chip shows for a thread. Only
 * the thread's own folders are asked about, once per answer: a worktree and
 * its repository share one. Undefined while nothing is asked, so the bar shows
 * no chip. A failed read is reported, since it would otherwise hide every
 * question.
 */
export function useWorkspaceTrustAsk({
  memoryResourceId,
  openFolders,
  threadId,
}: {
  readonly memoryResourceId: string;
  /** The workspace's open folders; read only as a signal that one was added or removed. */
  readonly openFolders: unknown;
  readonly threadId: string | undefined;
}): WorkspaceBarTrust | undefined {
  const discovery = useAssistantThreadHost()?.workspaceDiscovery;
  const folderIds = threadFolderIds(useResourceThread(memoryResourceId, threadId));
  // A thread that moves to a worktree created since the last read needs a fresh one.
  const folderIdsKey = typeof folderIds === 'string' ? folderIds : folderIds.join('\n');
  // A reload trigger only, like the folders above: an answer given anywhere.
  const revision = useWorkspaceTrustRevision();
  const [roots, setRoots] = useState<readonly WorkspaceTrustRoot[]>([]);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The cause goes to the log; the person sees what it means and can retry.
  const [readFailed, setReadFailed] = useState(false);
  // A pull can add AGENTS.md or a skill to a mounted folder; returning to the window re-reads.
  const [readCount, setReadCount] = useState(0);
  // Last requested wins: a slow older read never replaces a fresher one.
  const generationRef = useRef(0);

  useEffect(() => {
    if (!discovery || hasFactoryResetPreparationStarted()) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    discovery
      .listTrust()
      .then((result) => {
        if (generation === generationRef.current) {
          setRoots(result);
          setReadFailed(false);
        }
      })
      .catch((error: unknown) => {
        // The reset stops the host under a read it overtook (ADR-0015).
        if (hasFactoryResetPreparationStarted()) {
          return;
        }
        logger.error('Failed to read workspace trust', { error });
        if (generation === generationRef.current) {
          setReadFailed(true);
        }
      });
    return () => {
      generationRef.current += 1;
    };
  }, [discovery, folderIdsKey, openFolders, revision, readCount]);

  useEffect(() => {
    if (!discovery) {
      return;
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        setReadCount((count) => count + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [discovery]);

  const asks = trustAsks(threadFolders(roots, folderIds));
  if (!discovery || (asks.length === 0 && !readFailed)) {
    return;
  }
  return {
    actionError,
    asks,
    busyPath,
    // The host records the answer; the revision it bumps reloads this list and the "/" menu.
    onDecide: (ask, decision, location) => {
      setBusyPath(ask.path);
      // A location is sent only when the person ticked the ask's box.
      (location === undefined
        ? discovery.setTrust(ask.path, decision)
        : discovery.setTrust(ask.path, decision, location)
      )
        .then(
          () => setActionError(null),
          (error: unknown) =>
            setActionError(errorMessage(error, 'The agent host refused the change'))
        )
        .finally(() => setBusyPath(null));
    },
    onRetry: readFailed ? () => setReadCount((count) => count + 1) : undefined,
  };
}
