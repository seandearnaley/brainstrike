/**
 * ADR-0034 Automatic isolation, the platform's part: the worktree Core asks
 * for when a thread's first edit would land in a folder another thread is
 * editing, and which of a thread's earlier paths git still holds uncommitted.
 *
 * The worktree is the worktree tool's own (`hostWorktreeToolDependencies`):
 * the one `WorktreeService` creates and records it as the agent's, under the
 * run and thread, and the host opens it as a folder. Its name is the
 * service's own suggestion and its branch is `bs/<name>`, as the create sheet
 * defaults them. It starts from the checkout's last commit.
 */
import type { HostPlatform } from '@brainstrike/agent-host';
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { GitStatus } from '@brainstrike/types';
import { gitRefused } from './git-failure.ts';
import {
  type HostWorktreeServices,
  hostWorktreeToolDependencies,
} from './worktree-tool-dependencies.ts';

type HostCheckoutIsolation = NonNullable<HostPlatform['checkoutIsolation']>;

function settled<T>(result: BoundaryResult<T>): T {
  if (!result.ok) {
    throw new BoundaryFailureError(result.error);
  }
  return result.value;
}

/** Undefined where the host cannot open a worktree as a folder: it isolates nothing. */
export function hostCheckoutIsolation(options: {
  readonly services: HostWorktreeServices;
  /** The folder's `git status`, as the Changes panel reads it: paths relative to the folder. */
  readonly status: (rootId: string) => Promise<BoundaryResult<GitStatus>>;
}): HostCheckoutIsolation | undefined {
  const { services } = options;
  if (!(services.openWorktreeFolder && services.resolveWorktreeService)) {
    return;
  }
  const { resolveWorktreeService } = services;
  return {
    create: async ({ rootId, runId, signal, threadId }) => {
      const service = resolveWorktreeService();
      const { worktreeTools } = hostWorktreeToolDependencies(services, { runId, threadId });
      if (!(service && worktreeTools)) {
        throw new BoundaryFailureError(
          gitRefused(
            'configuration',
            'worktree.service-unavailable',
            'Worktree management is not available in this session.'
          ).error
        );
      }
      const { suggestedName: name } = settled(await service.createContext({ rootId }));
      signal.throwIfAborted();
      const created = settled(
        await worktreeTools.create({ baseRef: 'HEAD', branch: `bs/${name}`, name, rootId })
      );
      return {
        branch: created.worktree.branch,
        localRootId: rootId,
        root: created.root,
        worktreeId: created.worktree.id,
      };
    },
    uncommitted: async ({ paths, rootId, signal }) => {
      const { files } = settled(await options.status(rootId));
      signal.throwIfAborted();
      const changed = new Set(
        files.flatMap((file) => [file.path, ...(file.originalPath ? [file.originalPath] : [])])
      );
      return paths.filter((candidate) => changed.has(candidate));
    },
  };
}
