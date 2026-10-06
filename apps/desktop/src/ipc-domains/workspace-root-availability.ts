import { createLogger } from '@brainstrike/logging';
import type { StoredWorkspaceRoot } from './workspace-root-types';

const logger = createLogger('WorkspaceRootRegistry');

/** Session warning episodes track actual absence, independently of saved grants. */
export class WorkspaceRootAvailability {
  private readonly unavailableRoots = new Map<string, string>();

  clear(): void {
    this.unavailableRoots.clear();
  }

  forget(rootId: string): void {
    this.unavailableRoots.delete(rootId);
  }

  retain(entries: readonly StoredWorkspaceRoot[]): void {
    const storedIds = new Set(entries.map((entry) => entry.rootId));
    for (const rootId of this.unavailableRoots.keys()) {
      if (!storedIds.has(rootId)) {
        this.unavailableRoots.delete(rootId);
      }
    }
  }

  async tryMount(
    entry: StoredWorkspaceRoot,
    pathExists: (rootPath: string) => Promise<boolean>,
    mount: (entry: StoredWorkspaceRoot) => Promise<string>
  ): Promise<{ canonicalPath: string; ok: true } | { ok: false }> {
    try {
      if (!(await pathExists(entry.path))) {
        if (this.unavailableRoots.get(entry.rootId) !== entry.path) {
          this.unavailableRoots.set(entry.rootId, entry.path);
          logger.warn('Workspace root is unavailable and will remain persisted for retry', {
            rootId: entry.rootId,
          });
        }
        return { ok: false };
      }
      // Filesystem recovery ends the absence even if the distinct mount fails.
      this.forget(entry.rootId);
      return { canonicalPath: await mount(entry), ok: true };
    } catch (error) {
      logger.error('Workspace root mount failed and remains persisted for retry', {
        error,
        rootId: entry.rootId,
      });
      return { ok: false };
    }
  }
}
