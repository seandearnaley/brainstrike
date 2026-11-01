import {
  createNativeSecureRoot,
  type MountedWorkspaceRoot,
  type SecureWorkspaceRoot,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { WorkspaceRootMounts } from '../../src/workspace-files/root-pins.ts';

/**
 * Folders mounted once at grant, as the host's root registry mounts them: one handle each, which
 * every later read and watch borrows. The registry's own retirement rules are its tests'.
 */
export async function grantedMounts(
  roots: readonly { readonly path: string; readonly rootId: string }[],
  openRoot: (rootPath: string) => Promise<SecureWorkspaceRoot> = createNativeSecureRoot
): Promise<WorkspaceRootMounts & { close(): void }> {
  const mounted = new Map<string, MountedWorkspaceRoot>();
  for (const root of roots) {
    const handle = await openRoot(root.path);
    mounted.set(root.rootId, {
      canonicalPath: handle.canonicalPath,
      presentationPath: root.path,
      root: handle,
      rootId: root.rootId,
    });
  }
  return {
    close: () => {
      for (const { root } of mounted.values()) {
        root.close();
      }
      mounted.clear();
    },
    mountedRoots: () =>
      [...mounted.values()].map((root) => ({
        canonicalPath: root.canonicalPath,
        path: root.presentationPath,
        rootId: root.rootId,
      })),
    useMountedRoot: async (rootId, use) => {
      const root = mounted.get(rootId);
      if (!root) {
        throw new Error('The folder is not mounted');
      }
      return await use(root);
    },
  };
}
