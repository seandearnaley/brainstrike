/**
 * The project of a repository found inside an open folder (ADR-0034 build decisions, BST-2511,
 * BST-2520).
 *
 * The inventory walks down from each open folder, so it finds a repository whose own checkout is
 * inside one without being one. Such a repository has no root to carry a project, so the store's
 * roots domain, the one writer of projects, keeps its project by the checkout's canonical path.
 *
 * The listing only reads: one lookup, for the own checkouts of every repository listed that is
 * not an open folder, whether or not a mounted folder holds it now, so a named repository keeps
 * its section while the folder that holds it is closed. A project is made only by the person's
 * first Rename project… or Move to project… on the repository's section, in the store's commit
 * for that change; a listing never writes, so the walk's submodules and fixture repositories get
 * no rows, and no one repository can fail the listing.
 */
import type { StateStore } from '@brainstrike/state-store';
import type { WorktreeListEntry } from '@brainstrike/types';
import type { WorktreeService } from './worktree-service.ts';

/** The store's roots domain, which keeps projects. */
export type RepositoryProjectStore = Pick<StateStore, 'workspaceRoots'>;

/** `entries` with the project kept for each repository's own checkout that is no open folder. */
async function readRepositoryProjects(
  entries: readonly WorktreeListEntry[],
  store: RepositoryProjectStore
): Promise<readonly WorktreeListEntry[]> {
  const checkouts = entries
    .filter((entry) => entry.primary && !entry.rootIdIsExactMount)
    .map(({ path }) => path);
  if (checkouts.length === 0) {
    return entries;
  }
  const { projects } = await store.workspaceRoots({
    canonicalPaths: checkouts,
    operation: 'repository-projects',
  });
  if (projects === undefined) {
    throw new Error('The store answered no projects for the repositories it was asked about');
  }
  const byPath = new Map(projects.map((project) => [project.canonicalPath, project]));
  return entries.map((entry) => {
    const project = entry.primary && !entry.rootIdIsExactMount ? byPath.get(entry.path) : undefined;
    return project === undefined
      ? entry
      : { ...entry, projectId: project.id, projectName: project.name };
  });
}

/**
 * The worktree service as the host's `worktrees/list` serves it: its listing names the project
 * kept for each repository found inside an open folder. A store failure fails it visibly.
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
        ? { ok: true, value: await readRepositoryProjects(listed.value, store) }
        : listed;
    },
  };
}
