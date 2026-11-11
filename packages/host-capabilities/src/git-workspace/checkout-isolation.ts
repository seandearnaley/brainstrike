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
 *
 * A folder that cannot be given a worktree gets none, and Core is told why
 * (`noWorktree`), read from the repository git reports for the folder before
 * anything is created.
 */
import type { HostPlatform } from '@brainstrike/agent-host';
import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { GitRepository, GitStatus } from '@brainstrike/types';
import { gitRefused } from './git-failure.ts';
import {
  type HostWorktreeServices,
  hostWorktreeToolDependencies,
} from './worktree-tool-dependencies.ts';

type HostCheckoutIsolation = NonNullable<HostPlatform['checkoutIsolation']>;
type NoWorktree = Extract<
  Awaited<ReturnType<HostCheckoutIsolation['create']>>,
  { readonly noWorktree: string }
>;

/** The object id git reports for a HEAD with no commit: every digit zero. */
const NO_COMMIT = /^0+$/u;

function settled<T>(result: BoundaryResult<T>): T {
  if (!result.ok) {
    throw new BoundaryFailureError(result.error);
  }
  return result.value;
}

/**
 * Why a folder cannot be given a worktree, read from what git reports of it
 * before anything is created; undefined when it can. Its threads share it.
 */
function noWorktree(repository: BoundaryResult<GitRepository>): NoWorktree | undefined {
  // A folder outside git has no checkout to make a worktree of.
  if (!repository.ok && repository.error.code === 'git.not-a-repository') {
    return { noWorktree: 'not-a-repository' };
  }
  const { currentWorktree, scope } = settled(repository);
  // A worktree is a checkout of the whole repository. Opened in place of a folder inside
  // one, it would take the thread's relative paths somewhere else.
  if (scope === 'workspace') {
    return { noWorktree: 'inside-a-repository' };
  }
  // A worktree starts from the last commit, and `git worktree add` fails without one.
  if (currentWorktree.head === null || NO_COMMIT.test(currentWorktree.head)) {
    return { noWorktree: 'no-commit-yet' };
  }
  return;
}

/** Undefined where the host cannot open a worktree as a folder: it isolates nothing. */
export function hostCheckoutIsolation(options: {
  /** The folder's repository as git reports it (`git/repository`): its top folder and last commit. */
  readonly repository: (rootId: string) => Promise<BoundaryResult<GitRepository>>;
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
      const none = noWorktree(await options.repository(rootId));
      if (none) {
        return none;
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
      // One Unicode form on both sides: macOS git reports a name precomposed however it is stored.
      const changed = files
        .flatMap((file) => [file.path, ...(file.originalPath ? [file.originalPath] : [])])
        .map((entry) => entry.normalize('NFC'));
      const names = new Set(changed);
      // A folder git reports as one entry (a nested repository) covers every path in it.
      const folders = changed.filter((entry) => entry.endsWith('/'));
      return paths.filter((candidate) => {
        const name = candidate.normalize('NFC');
        return names.has(name) || folders.some((folder) => name.startsWith(folder));
      });
    },
  };
}
