import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type GitBridge, type GitStatus, resolveGitBridge } from './git-bridge';

const logger = createLogger('GitPanel');

export interface UseGitPanelResult {
  /** Durable rootId of the focused workspace root, or null if none is open. */
  readonly activeRootId: string | null;
  readonly commit: (message: string) => Promise<boolean>;
  /** True while a status fetch is in flight. */
  readonly isLoading: boolean;
  /** True while a push or pull network op is running. */
  readonly isSyncing: boolean;
  /** Loads a diff for a file, or null on error (error already toasted). */
  readonly loadDiff: (path: string, staged: boolean) => Promise<LoadedDiff | null>;
  readonly pull: () => Promise<void>;
  readonly push: () => Promise<void>;
  readonly refresh: () => void;
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
  const [isLoading, setIsLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Bumped to force a refresh after a mutation or a manual refresh click.
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => {
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
    setIsLoading(true);
    setStatusError(null);

    bridge
      .status(activeRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setStatus(result.value);
          setStatusError(null);
        } else {
          setStatus(null);
          setStatusError(result.error);
          logger.error('git status failed', { error: result.error });
          toast({
            title: 'Git status failed',
            description: result.error,
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
        toast({ title: 'Git status failed', description: message, variant: 'destructive' });
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bridge, activeRootId, refreshToken, toast]);

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
          toast({ title: `${label} failed`, description: result.error, variant: 'destructive' });
          return false;
        }
        refresh();
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${label} threw`, { error: message });
        toast({ title: `${label} failed`, description: message, variant: 'destructive' });
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
    async (message: string): Promise<boolean> => {
      const trimmed = message.trim();
      if (trimmed.length === 0) {
        toast({
          title: 'Commit failed',
          description: 'Enter a commit message first.',
          variant: 'destructive',
        });
        return false;
      }
      return await runMutation('Commit', async (b, rootId) => {
        const result = await b.commit(rootId, { message: trimmed });
        if (result.ok) {
          toast({
            title: 'Committed',
            description: `${result.value.commit}${result.value.branch ? ` on ${result.value.branch}` : ''}`,
          });
        }
        return result;
      });
    },
    [runMutation, toast]
  );

  const push = useCallback(async (): Promise<void> => {
    if (!(bridge && activeRootId)) {
      return;
    }
    setIsSyncing(true);
    try {
      await runMutation('Push', async (b, rootId) => {
        const result = await b.push(rootId);
        if (result.ok) {
          toast({ title: 'Pushed', description: result.value.output || 'Up to date.' });
        }
        return result;
      });
    } finally {
      setIsSyncing(false);
    }
  }, [bridge, activeRootId, runMutation, toast]);

  const pull = useCallback(async (): Promise<void> => {
    if (!(bridge && activeRootId)) {
      return;
    }
    setIsSyncing(true);
    try {
      await runMutation('Pull', async (b, rootId) => {
        const result = await b.pull(rootId);
        if (result.ok) {
          toast({ title: 'Pulled', description: result.value.output || 'Already up to date.' });
        }
        return result;
      });
    } finally {
      setIsSyncing(false);
    }
  }, [bridge, activeRootId, runMutation, toast]);

  const loadDiff = useCallback(
    async (path: string, staged: boolean): Promise<LoadedDiff | null> => {
      if (!(bridge && activeRootId)) {
        return null;
      }
      try {
        const result = await bridge.diff(activeRootId, { path, staged });
        if (!result.ok) {
          logger.error('git diff failed', { error: result.error, path });
          toast({ title: 'Diff failed', description: result.error, variant: 'destructive' });
          return null;
        }
        return { unifiedDiff: result.value.unifiedDiff, truncated: result.value.truncated };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('git diff threw', { error: message, path });
        toast({ title: 'Diff failed', description: message, variant: 'destructive' });
        return null;
      }
    },
    [bridge, activeRootId, toast]
  );

  return {
    activeRootId,
    status,
    isLoading,
    statusError,
    isSyncing,
    refresh,
    stageFile,
    unstageFile,
    commit,
    push,
    pull,
    loadDiff,
  };
}
