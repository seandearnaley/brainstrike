import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  isStateStoreReadOnly,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import {
  createNativeSecureRoot,
  type ManagedWorktreeAuthorizer,
  type MountedWorkspaceRoot,
  resolveCanonicalRootPath,
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
  type WorkspaceRootStorage,
} from '@brainstrike/assistant-service/node-workspace-services';
import { AccessError } from '@brainstrike/file-system';
import {
  ParcelWatchRetirementError,
  startJoinedParcelWatch,
} from '@brainstrike/file-system/native-watch';
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';
import { type LifecycleDelays, lifecycleDelay } from '@brainstrike/host-lease/lifecycle-delays';
import type { StateStore } from '@brainstrike/state-store';
import type {
  FileSystemChange,
  FileSystemWatchBatchMetadata,
  WatcherHealthTransition,
} from '@brainstrike/types';
import { evictLspServersForRoot } from '../assistant-server/lsp-diagnostics';
import {
  createWorkspaceRootWatchOwner,
  type WorkspaceRootWatchOwner,
} from '../ipc-domains/workspace-root-watch-owner';
import type { E2eSyntheticFiles } from './e2e-synthetic-files';
import { hostCommandSessionManager } from './host-tool-process';

/** The folder grants, last folder and recents: this host's settings, beside the profile's roots. */
const FOLDER_SETTING_PREFIX = 'workspace/folders/';

export interface VisibleRootWatch {
  close(): Promise<void>;
  retry(): Promise<void>;
}

export interface DesktopWorkspaceRoots {
  close(): Promise<void>;
  readonly roots: WorkspaceRootRegistry;
  /** The Explorer's recursive watch of a mounted folder, sharing that folder's one native watcher. */
  startVisibleWatch(
    directoryPath: string,
    onChanges: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    onHealth: (transition: WatcherHealthTransition) => void
  ): Promise<VisibleRootWatch>;
  /** The folder ledgers, written as a saved profile has them (E2E seeding). */
  readonly storage: WorkspaceRootStorage;
  readonly watches: WorkspaceRootWatchOwner;
}

interface DesktopWorkspaceRootsOptions {
  readonly lifecycleDelays: LifecycleDelays;
  readonly managedWorktreeAuthorizer: ManagedWorktreeAuthorizer;
  /** A restore mounted other folders than the index last borrowed: the index re-reads them. */
  readonly onRestoredRootsChanged: () => void;
  readonly onRootGranted: (grantedPath: string) => void;
  readonly store: StateStore;
  /** Only in a desktop E2E launch. */
  readonly synthetic?: E2eSyntheticFiles | undefined;
}

function folderStorage(store: StateStore): WorkspaceRootStorage {
  return {
    getItem: async (key) => (await store.getSetting(`${FOLDER_SETTING_PREFIX}${key}`)) ?? null,
    removeItem: async (key) => {
      await store.deleteSetting(`${FOLDER_SETTING_PREFIX}${key}`);
    },
    setItem: (key, value) => store.setSetting(`${FOLDER_SETTING_PREFIX}${key}`, value),
  };
}

async function pathExistsOnDisk(rootPath: string): Promise<boolean> {
  try {
    await access(rootPath);
    return true;
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return false;
    }
    throw cause;
  }
}

/** A read inside a mounted root; it may not leave the root, and must exist. */
async function resolveDiskReadPath(requestedPath: string, canonicalRoot: string): Promise<string> {
  const result = await resolveValidatedPath({
    allowMissing: false,
    maxTraversal: 0,
    requestedPath,
    rootDir: canonicalRoot,
  });
  if (!result.ok) {
    throw new AccessError(`Path validation failed: ${result.error.message}`, requestedPath, 'read');
  }
  return result.path;
}

function syntheticSecureRoot(rootPath: string, synthetic: E2eSyntheticFiles): SecureWorkspaceRoot {
  return {
    canonicalPath: path.normalize(rootPath),
    close: () => undefined,
    listDir: async (relativePath, maxEntries) => {
      const nodes = await synthetic.readDirectory(
        relativePath === '.' ? rootPath : path.join(rootPath, relativePath)
      );
      return {
        entries: nodes.slice(0, maxEntries).map((node) => ({
          isDirectory: node.type === 'directory',
          isFile: node.type === 'file',
          isSymbolicLink: false,
          ...(node.lastModified === undefined ? {} : { lastModified: node.lastModified }),
          name: node.name,
          ...(node.size === undefined ? {} : { size: node.size }),
        })),
        inspected: Math.min(nodes.length, maxEntries),
        truncated: nodes.length > maxEntries,
      };
    },
    readFile: async (relativePath) => {
      const content = await synthetic.readFile(path.join(rootPath, relativePath));
      return content === undefined
        ? { status: 'not-found' }
        : { content: Buffer.from(content), status: 'ok' };
    },
  };
}

/**
 * ADR-0029 stage 4: the desktop's workspace folders, owned by its agent host. The
 * registry mounts each granted folder once; the watch owner runs that folder's one
 * `@parcel/watcher` subscription, which the Explorer and the index both borrow.
 */
export function createDesktopWorkspaceRoots({
  lifecycleDelays,
  managedWorktreeAuthorizer,
  onRestoredRootsChanged,
  onRootGranted,
  store,
  synthetic,
}: DesktopWorkspaceRootsOptions): DesktopWorkspaceRoots {
  // A canonical root is mock or real for the registry's whole life, never both.
  const classifications = new Map<string, boolean>();
  const bindClassification = (rootPath: string, classification: boolean): void => {
    const key = path.normalize(rootPath);
    const cached = classifications.get(key);
    if (cached !== undefined && cached !== classification) {
      throw new Error('Conflicting filesystem classification for canonical workspace root.');
    }
    classifications.set(key, classification);
  };
  const isSynthetic = async (rootPath: string): Promise<boolean> => {
    if (!synthetic) {
      return false;
    }
    const cached = classifications.get(path.normalize(rootPath));
    if (cached !== undefined) {
      return cached;
    }
    const classification = await synthetic.owns(rootPath);
    bindClassification(rootPath, classification);
    return classification;
  };
  const storage = folderStorage(store);
  const roots = new WorkspaceRootRegistry({
    createSecureRoot: async (rootPath) => {
      if (synthetic && (await isSynthetic(rootPath))) {
        return syntheticSecureRoot(rootPath, synthetic);
      }
      const root = await createNativeSecureRoot(rootPath);
      try {
        bindClassification(root.canonicalPath, false);
      } catch (error) {
        root.close();
        throw error;
      }
      return root;
    },
    disposeCommandSessionsForRoot: (rootId) => hostCommandSessionManager().disposeRoot(rootId),
    evictLspServersForRoot,
    getRootsCatalog: async () => store,
    // A damaged store opened read-only (BST-2144); its refusal is expected.
    isExpectedCatalogRefusal: isStateStoreReadOnly,
    onRestoredRootsChanged,
    onRootGranted,
    pathExists: async (rootPath) =>
      synthetic && (await synthetic.owns(rootPath))
        ? synthetic.exists(rootPath)
        : pathExistsOnDisk(rootPath),
    resolveCanonicalRoot: async (rootPath) => {
      if (await isSynthetic(rootPath)) {
        return path.normalize(rootPath);
      }
      const canonicalRoot = await resolveCanonicalRootPath(rootPath);
      bindClassification(canonicalRoot, false);
      return canonicalRoot;
    },
    resolveReadPath: async (requestedPath, canonicalRoot) => {
      if (!(await isSynthetic(canonicalRoot))) {
        return resolveDiskReadPath(requestedPath, canonicalRoot);
      }
      const candidate = path.isAbsolute(requestedPath)
        ? path.normalize(requestedPath)
        : path.resolve(canonicalRoot, requestedPath);
      const relative = path.relative(canonicalRoot, candidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw refusalError(
          'authorization',
          'workspace.path-outside-root',
          'Path is outside the selected workspace root.',
          'Choose a file inside the selected folder.'
        );
      }
      return candidate;
    },
    storage,
  });
  roots.setManagedWorktreeAuthorizer(managedWorktreeAuthorizer);
  const watches = createWorkspaceRootWatchOwner({
    startWatch: (mounted, onChanges, onHealth) =>
      startJoinedParcelWatch(
        {
          kind: 'directory',
          name: path.basename(mounted.canonicalPath),
          path: mounted.canonicalPath,
          platform: 'electron',
        },
        onChanges,
        {
          beforeSubscribe: () => lifecycleDelay(lifecycleDelays, 'parcel-subscribe'),
          onHealth,
          // The Explorer's watcher is the sole opt-in to bounded filtered-boundary reports.
          reportDefaultFilteredChanges: true,
        }
      ),
  });
  return {
    close: async () => {
      const results = await Promise.allSettled([watches.close(), roots.dispose()]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Workspace folders did not retire.');
      }
      classifications.clear();
    },
    roots,
    startVisibleWatch: async (directoryPath, onChanges, onHealth) => {
      let mounted: MountedWorkspaceRoot | undefined;
      const lease = await roots.borrowSourceRootForPath(directoryPath, (root, ...callbacks) => {
        mounted = root;
        return watches.subscribe(root, ...callbacks);
      });
      try {
        await lease.subscribe(
          (changes, metadata) => onChanges([...changes], metadata),
          () => undefined,
          onHealth,
          { requestId: 'visible-root-watch', signal: new AbortController().signal }
        );
        const captured = mounted;
        if (!captured) {
          throw new Error('Visible root watch did not acquire the mounted capability.');
        }
        return { close: () => lease.retire(), retry: () => watches.retry(captured) };
      } catch (error) {
        try {
          await lease.retire();
        } catch (retirementError) {
          throw new ParcelWatchRetirementError([error, retirementError], () => lease.retire());
        }
        throw error;
      }
    },
    storage,
    watches,
  };
}
