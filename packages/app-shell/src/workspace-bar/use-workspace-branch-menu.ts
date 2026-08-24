import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { WorkspaceBarBranchMenu, WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import { buildBranchSwitchModel } from '../git-panel/branch-switch-model';
import type { GitBridge, GitRepository, GitResult } from '../git-panel/git-bridge';

const logger = createLogger('WorkspaceBranchMenu');
const DIRTY_REFUSAL =
  'This checkout has uncommitted changes. Direct switching was refused, and switching in a new worktree is unavailable until Worktree support lands.';

interface WorkspaceBranchRoot {
  readonly path: string;
  readonly rootId: string;
}

interface UseWorkspaceBranchMenuArgs {
  readonly bridge: GitBridge | null;
  readonly checkout: WorkspaceBarCheckout | undefined;
  readonly onBranchChanged: (branch: string) => void;
  readonly root: WorkspaceBranchRoot | null;
}

interface RepositoryState {
  readonly repository: GitRepository;
  readonly rootId: string;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWorkspaceBranchMenu({
  bridge,
  checkout,
  onBranchChanged,
  root,
}: UseWorkspaceBranchMenuArgs): WorkspaceBarBranchMenu | null {
  const [repositoryState, setRepositoryState] = useState<RepositoryState | null>(null);
  const [loadingRootId, setLoadingRootId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const openChangeset = useChangesNavigationStore((state) => state.openChangeset);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const rootId = root?.rootId ?? null;
  const repository = repositoryState?.rootId === rootId ? repositoryState.repository : null;

  const publishFailure = useCallback((title: string, detail: string): void => {
    logger.error(title.toLowerCase(), { error: detail });
    toast({ description: detail, title, variant: 'destructive' });
  }, []);

  const loadRepository = useCallback(async (): Promise<GitRepository | null> => {
    if (!(bridge && rootId)) {
      return null;
    }
    setLoadingRootId(rootId);
    try {
      const result = await bridge.repository(rootId);
      if (!result.ok) {
        publishFailure('Repository details failed', result.error);
        return null;
      }
      setRepositoryState({ repository: result.value, rootId });
      return result.value;
    } catch (error: unknown) {
      publishFailure('Repository details failed', failureMessage(error));
      return null;
    } finally {
      setLoadingRootId((current) => (current === rootId ? null : current));
    }
  }, [bridge, publishFailure, rootId]);

  const requireCleanCheckout = useCallback(async (): Promise<boolean> => {
    if (!(bridge && rootId)) {
      return false;
    }
    if (checkout?.dirty) {
      publishFailure('Branch switch unavailable', DIRTY_REFUSAL);
      return false;
    }
    try {
      const result = await bridge.status(rootId);
      if (!result.ok) {
        publishFailure('Git status failed', result.error);
        return false;
      }
      if (!result.value.clean) {
        publishFailure('Branch switch unavailable', DIRTY_REFUSAL);
        return false;
      }
      return true;
    } catch (error: unknown) {
      publishFailure('Git status failed', failureMessage(error));
      return false;
    }
  }, [bridge, checkout?.dirty, publishFailure, rootId]);

  const runMutation = useCallback(
    async <T>(
      title: string,
      run: (git: GitBridge, id: string) => Promise<GitResult<T>>
    ): Promise<{ readonly ok: true; readonly value: T } | null> => {
      if (!(bridge && rootId)) {
        return null;
      }
      try {
        const result = await run(bridge, rootId);
        if (!result.ok) {
          publishFailure(`${title} failed`, result.error);
          return null;
        }
        return result;
      } catch (error: unknown) {
        publishFailure(`${title} failed`, failureMessage(error));
        return null;
      }
    },
    [bridge, publishFailure, rootId]
  );

  const rows = useMemo(
    () =>
      repository && checkout
        ? buildBranchSwitchModel({
            branches: repository.branches,
            dirty: checkout.dirty,
            query,
            scope: repository.scope,
          }).rows
        : [],
    [checkout, query, repository]
  );

  if (!(bridge && root && checkout)) {
    return null;
  }

  return {
    defaultRemote: repository?.defaultRemote ?? null,
    loading: loadingRootId === root.rootId,
    onCreateBranch: async (branch) => {
      if (!(await requireCleanCheckout())) {
        return false;
      }
      const result = await runMutation('Create branch', (git, id) =>
        git.createBranch(id, { branch })
      );
      if (!result) {
        return false;
      }
      onBranchChanged(result.value.branch);
      toast({ description: result.value.branch, title: 'Branch created' });
      await loadRepository();
      return true;
    },
    onFetch: async (remote) => {
      const result = await runMutation('Fetch', (git, id) => git.fetch(id, { remote }));
      if (!result) {
        return false;
      }
      toast({ description: result.value.output || 'Up to date.', title: 'Fetched' });
      await loadRepository();
      return true;
    },
    onOpenChange: (open) => {
      if (open) {
        void loadRepository();
      }
    },
    onOpenChanges: () => {
      if (!repository) {
        publishFailure('Open Changes failed', 'Repository details have not loaded yet.');
        return;
      }
      openChangeset({
        kind: 'git-scope',
        repositoryRoot: repository.repositoryRoot,
        scope: { kind: 'uncommitted' },
        worktreePath: repository.currentWorktree.path,
      });
      setActiveTab('explorer');
    },
    onQueryChange: setQuery,
    onSwitchBranch: async (branch) => {
      const row = rows.find((candidate) => candidate.name === branch);
      if (!row?.switchable) {
        if (row?.disabledReason) {
          publishFailure('Branch switch unavailable', row.disabledReason);
        }
        return false;
      }
      if (!(await requireCleanCheckout())) {
        return false;
      }
      const result = await runMutation('Switch branch', (git, id) =>
        git.switchBranch(id, { branch })
      );
      if (!result) {
        return false;
      }
      onBranchChanged(result.value.branch);
      toast({ description: result.value.branch, title: 'Branch switched' });
      await loadRepository();
      return true;
    },
    query,
    remotes: repository?.remotes ?? [],
    rows,
  };
}
