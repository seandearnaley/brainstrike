import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isTransientRootError,
  TRANSIENT_ROOT_RETRY_DELAY_MS,
  TRANSIENT_ROOT_RETRY_LIMIT,
} from '../roots/transient-root-error';
import { type GitBridge, type GitRepository, type GitStatus, resolveGitBridge } from './git-bridge';

const logger = createLogger('GitPanel');

export interface UseGitPanelResult {
  /** Durable rootId of the focused workspace root, or null if none is open. */
  readonly activeRootId: string | null;
  readonly commit: (summary: string, description?: string) => Promise<boolean>;
  /** True while a status fetch is in flight. */
  readonly isLoading: boolean;
  /** True while a push or pull network op is running. */
  readonly isSyncing: boolean;
  /** Loads a diff for a file, or null on error (error already toasted). */
  readonly loadDiff: (
    path: string,
    options: { staged: boolean; untracked: boolean }
  ) => Promise<LoadedDiff | null>;
  readonly pull: () => Promise<void>;
  readonly push: (remote?: string) => Promise<void>;
  readonly refresh: () => void;
  readonly repository: GitRepository | null;
  readonly repositoryError: string | null;
  readonly stageFile: (path: string) => Promise<void>;
  /** Parsed status for the active root; null until first load / when no root. */
  readonly status: GitStatus | null;
  /** A non-recoverable status-load error (e.g. bridge failure), else null. */
  readonly statusError: string | null;
  readonly unstageFile: (path: string) => Promise<void>;
}

export interface LoadedDiff {
  readonly truncated: boolean;
  readonly unifiedDiff: string;
}

/**
 * Owns all `window.git` interaction for the Git panel: it resolves the focused
 * workspace root's durable `rootId` (re-fetching status whenever the focused
 * root changes), exposes status + ahead/behind, and wraps every mutation so a
 * `{ ok: false }` GitResult or a thrown/rejected call becomes a toast + log
 * (no silent failures), then refreshes status after a successful action.
 *
 * The `bridge` is resolved once (the preload bridge exists for the window's
 * lifetime); when it is absent the hook is inert and `activeRootId` gating in
 * the panel renders the desktop-only empty state.
 */
export function useGitPanel(): UseGitPanelResult {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  const { toast } = useToast();
  const bridgeRef = useRef<GitBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveGitBridge();
  }
  const bridge = bridgeRef.current;

  const activeRootId = useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    // Prefer the durable, self-identifying handle.rootId; fall back to the
    // path→id map for legacy single-root handles. Matches the resolution used
    // by every other workspace surface (see FileTreeWrapper).
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [repository, setRepository] = useState<GitRepository | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Bumped to force a refresh after a mutation or a manual refresh click.
  const [refreshToken, setRefreshToken] = useState(0);

  // Counts consecutive transient "root not reconciled yet" failures so the
  // silent boot-race retry loop is bounded. Reset on success, on a manual
  // refresh, and when the focused root changes.
  const transientRetryCountRef = useRef(0);

  const refresh = useCallback(() => {
    transientRetryCountRef.current = 0;
    setRefreshToken((token) => token + 1);
  }, []);

  // Load status whenever the focused root changes or a refresh is requested.
  // A stale closure cannot clobber a newer load: the in-flight rootId/token are
  // captured and a `cancelled` flag guards the async write-back.
  useEffect(() => {
    if (!(bridge && activeRootId)) {
      setStatus(null);
      setStatusError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setIsLoading(true);
    setStatusError(null);

    bridge
      .status(activeRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          transientRetryCountRef.current = 0;
          setStatus(result.value);
          setStatusError(null);
        } else if (
          isTransientRootError(result.error) &&
          transientRetryCountRef.current < TRANSIENT_ROOT_RETRY_LIMIT
        ) {
          // Boot race: the workspace root row hasn't reconciled into the DB
          // yet. Keep the loading state and poll again shortly — no error UI,
          // no toast — until it lands or the retry budget runs out.
          transientRetryCountRef.current += 1;
          logger.debug('git status waiting for workspace root reconciliation', {
            attempt: transientRetryCountRef.current,
            error: result.error,
          });
          retryTimer = setTimeout(() => {
            if (!cancelled) {
              setRefreshToken((token) => token + 1);
            }
          }, TRANSIENT_ROOT_RETRY_DELAY_MS);
          return;
        } else {
          setStatus(null);
          setStatusError(result.error);
          logger.error('git status failed', { error: result.error });
          toast({
            description: result.error,
            title: 'Git status failed',
            variant: 'destructive',
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setStatus(null);
        setStatusError(message);
        logger.error('git status threw', { error: message });
        toast({ description: message, title: 'Git status failed', variant: 'destructive' });
      })
      .finally(() => {
        // Keep the loading state up while a transient-root retry is pending so
        // the panel shows "loading", not a flash of empty/error UI.
        if (!(cancelled || retryTimer)) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [bridge, activeRootId, refreshToken, toast]);

  useEffect(() => {
    if (!(bridge && activeRootId && status?.isRepository)) {
      setRepository(null);
      setRepositoryError(null);
      return;
    }
    let cancelled = false;
    bridge
      .repository(activeRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setRepository(result.value);
          setRepositoryError(null);
          return;
        }
        setRepository(null);
        setRepositoryError(result.error);
        logger.error('git repository metadata failed', { error: result.error });
        toast({
          description: result.error,
          title: 'Repository details failed',
          variant: 'destructive',
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setRepository(null);
        setRepositoryError(message);
        logger.error('git repository metadata threw', { error: message });
        toast({
          description: message,
          title: 'Repository details failed',
          variant: 'destructive',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeRootId, bridge, refreshToken, status?.isRepository, toast]);

  // A different focused root starts with a fresh transient-retry budget.
  useEffect(() => {
    transientRetryCountRef.current = 0;
  }, [activeRootId]);

  /**
   * Run a mutating git op, surfacing any failure as a toast + log, and refresh
   * status on success. Returns whether the op succeeded.
   */
  const runMutation = useCallback(
    async (
      label: string,
      run: (
        bridge: GitBridge,
        rootId: string
      ) => Promise<{ ok: true } | { ok: false; error: string }>
    ): Promise<boolean> => {
      if (!(bridge && activeRootId)) {
        return false;
      }
      try {
        const result = await run(bridge, activeRootId);
        if (!result.ok) {
          logger.error(`${label} failed`, { error: result.error });
          toast({ description: result.error, title: `${label} failed`, variant: 'destructive' });
          return false;
        }
        refresh();
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${label} threw`, { error: message });
        toast({ description: message, title: `${label} failed`, variant: 'destructive' });
        return false;
      }
    },
    [bridge, activeRootId, refresh, toast]
  );

  const stageFile = useCallback(
    async (path: string): Promise<void> => {
      await runMutation('Stage', (b, rootId) => b.stage(rootId, { path }));
    },
    [runMutation]
  );

  const unstageFile = useCallback(
    async (path: string): Promise<void> => {
      await runMutation('Unstage', (b, rootId) => b.unstage(rootId, { path }));
    },
    [runMutation]
  );

  const commit = useCallback(
    async (summary: string, description?: string): Promise<boolean> => {
      const trimmed = summary.trim();
      if (trimmed.length === 0) {
        toast({
          description: 'Enter a commit message first.',
          title: 'Commit failed',
          variant: 'destructive',
        });
        return false;
      }
      return await runMutation('Commit', async (b, rootId) => {
        const result = await b.commit(rootId, {
          ...(description?.trim() ? { description: description.trim() } : {}),
          summary: trimmed,
        });
        if (result.ok) {
          toast({
            description: `${result.value.commit}${result.value.branch ? ` on ${result.value.branch}` : ''}`,
            title: 'Committed',
          });
        }
        return result;
      });
    },
    [runMutation, toast]
  );

  const push = useCallback(
    async (remote?: string): Promise<void> => {
      if (!(bridge && activeRootId)) {
        return;
      }
      setIsSyncing(true);
      try {
        await runMutation('Push', async (b, rootId) => {
          const result = remote ? await b.push(rootId, { remote }) : await b.push(rootId);
          if (result.ok) {
            toast({ description: result.value.output || 'Up to date.', title: 'Pushed' });
          }
          return result;
        });
      } finally {
        setIsSyncing(false);
      }
    },
    [bridge, activeRootId, runMutation, toast]
  );

  const pull = useCallback(async (): Promise<void> => {
    if (!(bridge && activeRootId)) {
      return;
    }
    setIsSyncing(true);
    try {
      await runMutation('Pull', async (b, rootId) => {
        const result = await b.pull(rootId);
        if (result.ok) {
          toast({ description: result.value.output || 'Already up to date.', title: 'Pulled' });
        }
        return result;
      });
    } finally {
      setIsSyncing(false);
    }
  }, [bridge, activeRootId, runMutation, toast]);

  const loadDiff = useCallback(
    async (
      path: string,
      options: { staged: boolean; untracked: boolean }
    ): Promise<LoadedDiff | null> => {
      if (!(bridge && activeRootId)) {
        return null;
      }
      try {
        const result = await bridge.diff(activeRootId, {
          mode: options.untracked ? 'untracked' : options.staged ? 'staged' : 'working',
          path,
        });
        if (!result.ok) {
          logger.error('git diff failed', { error: result.error, path });
          toast({ description: result.error, title: 'Diff failed', variant: 'destructive' });
          return null;
        }
        return { truncated: result.value.truncated, unifiedDiff: result.value.unifiedDiff };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git diff threw', { error: message, path });
        toast({ description: message, title: 'Diff failed', variant: 'destructive' });
        return null;
      }
    },
    [bridge, activeRootId, toast]
  );

  return {
    activeRootId,
    commit,
    isLoading,
    isSyncing,
    loadDiff,
    pull,
    push,
    refresh,
    repository,
    repositoryError,
    stageFile,
    status,
    statusError,
    unstageFile,
  };
}
