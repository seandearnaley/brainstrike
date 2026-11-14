/**
 * The project of a repository found inside an open folder (ADR-0034 build decisions, BST-2511).
 *
 * The inventory walks down from each open folder, so it finds a repository whose own checkout
 * is inside one without being one. Its section in the Threads panel had no project to read: it
 * was keyed on the common dir, could not be named or joined, and its threads could split
 * between the folder's project and the repository. The worktree listing now names its project,
 * which the store's roots domain, the one writer of projects, keeps by the checkout's canonical
 * path (`ensure-repository-project`), as it keeps an open folder's.
 *
 * Only a checkout inside one of the person's folders counts: nothing looks above an opened
 * folder, so a repository reached only through a worktree of it, or inside a managed worktree or
 * a scratch folder, gets none. A store that opened damaged is read-only and records no project,
 * so such a repository keeps its common-dir section there.
 */
import type { StateStore, WorkspaceProjectRecord } from '@brainstrike/state-store';
import type { WorktreeListEntry } from '@brainstrike/types';
import type { WorktreeService } from './worktree-service.ts';

/** The store's roots domain, which keeps projects, and the damage it opened with. */
export type RepositoryProjectStore = Pick<StateStore, 'stateDamage' | 'workspaceRoots'>;

/** A repository's own checkout inside an open folder that it is not itself. */
function isNestedCheckout(entry: WorktreeListEntry): boolean {
  return entry.primary && !entry.rootIdIsExactMount && entry.containment !== 'outside-roots';
}

/**
 * `entries` with the project of each repository whose own checkout one of the person's folders
 * contains (a root of kind `path`), made by the store when it has none yet.
 */
async function nameRepositoryProjects(
  entries: readonly WorktreeListEntry[],
  store: RepositoryProjectStore
): Promise<readonly WorktreeListEntry[]> {
  const nested = entries.filter(isNestedCheckout);
  if (nested.length === 0 || store.stateDamage !== null) {
    return entries;
  }
  const { roots } = await store.workspaceRoots({ operation: 'list' });
  const folderRootIds = new Set(roots.filter((root) => root.kind === 'path').map(({ id }) => id));
  const inFolder = nested.filter(
    ({ containment }) =>
      containment !== 'outside-roots' && containment.some((rootId) => folderRootIds.has(rootId))
  );
  const projects = new Map<string, WorkspaceProjectRecord>(
    await Promise.all(
      inFolder.map(async ({ path }) => {
        const { project } = await store.workspaceRoots({
          canonicalPath: path,
          operation: 'ensure-repository-project',
        });
        if (project === undefined) {
          throw new Error('The store answered no project for a repository found in a folder');
        }
        return [path, project] as const;
      })
    )
  );
  return entries.map((entry) => {
    const project = entry.primary ? projects.get(entry.path) : undefined;
    return project === undefined
      ? entry
      : { ...entry, projectId: project.id, projectName: project.name };
  });
}

/**
 * The worktree service as the host's `worktrees/list` serves it: its listing names the project of
 * each repository found inside an open folder. A store failure fails the listing visibly.
 */
export function withRepositoryProjects(
  service: WorktreeService,
  store: RepositoryProjectStore
): WorktreeService {
  return {
    ...service,
    list: async () => {
      const listed = await service.list();
      return listed.ok
        ? { ok: true, value: await nameRepositoryProjects(listed.value, store) }
        : listed;
    },
  };
}
