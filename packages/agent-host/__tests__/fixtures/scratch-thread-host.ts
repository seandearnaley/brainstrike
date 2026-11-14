/**
 * The host the scratch-thread tests run (ADR-0034, Sean 2026-11-12): real Core
 * over a real state store, the real scratch folders (`hostScratchFolders`),
 * the real trust writer and a scripted model whose file tools write into the
 * folder its run is bound to. The platform's root registry is a small fake
 * over the store's own root records, and its Trash a folder of the test's.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import type { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { HostCore } from '../../src/core.js';
import type {
  HostPlatform,
  HostRunAdmissionRequest,
  HostScratchFolder,
  HostTool,
} from '../../src/ports.js';
import { type HostScratchFolderRoots, hostScratchFolders } from '../../src/scratch-folders.js';
import { crashableStorePort } from './child-run-host.js';

/** The folder a test opens in the workspace. */
export const OPEN = 'open-root';

export async function scratchThreadHost(
  model: MockLanguageModelV4,
  /** Receives the harness teardown; the caller runs it after the test. */
  cleanup: (() => Promise<void>)[]
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bs-scratch-thread-')));
  const userData = join(base, 'userData');
  const scratch = join(userData, 'scratch');
  const trash = join(base, 'Trash');
  await mkdir(trash);
  const open = join(base, 'project');
  await mkdir(open);
  const storeRoot = join(base, 'store');
  await mkdir(storeRoot);
  const store = await StateStore.open(storeRoot);
  // The folders each root id names, as a registry's mounts resolve them.
  const folders = new Map<string, string>();
  const trashed: string[] = [];
  const harness: {
    /** Set to make the next folder move fail with this cause, as a move to another disk does. */
    failMove?: Error;
    /** Holds every folder move until it resolves, as a slow disk does. */
    holdMove?: Promise<void>;
    /** Told as a folder move begins. */
    moveStarted?: () => void;
    /** Set to make the next move to the Trash fail with this cause, as a Trash that is missing does. */
    failTrash?: Error;
    /** What Main's folder picker answers, in turn: a folder, or null for a cancel. */
    picks: (string | null)[];
    /** How many times the picker was shown. */
    picked: number;
  } = { picked: 0, picks: [] };
  const requests: HostRunAdmissionRequest[] = [];
  /** The file tools of a run that works in `bound`, as the desktop admits them per run. */
  const fileTools = (bound: string): Record<string, HostTool> => ({
    write_file: {
      approvalTarget: () =>
        folders.has(bound) ? { displayName: bound, rootId: bound } : undefined,
      description: 'Write a workspace file',
      execute: async (input, context) => {
        const { content, path } = input as { content: string; path: string };
        const rootPath = folders.get(bound);
        if (!(rootPath && context.edits)) {
          // As the desktop's file tools refuse with no folder in the workspace.
          throw new Error('No folder is open in the workspace.');
        }
        const absolutePath = join(rootPath, path);
        await context.edits.track({ absolutePath, op: 'write', rootId: bound, rootPath }, () =>
          writeFile(absolutePath, content)
        );
        return { written: path };
      },
      identity: 'native-write-generation-1',
      inputSchema: z.object({ content: z.string(), path: z.string() }),
      risk: 'edit',
    },
  });
  // The registry's part: one change at a time, over the store's own root records.
  let changes: Promise<unknown> = Promise.resolve();
  const serially = <T>(change: () => Promise<T>): Promise<T> => {
    const next = changes.then(change);
    changes = next.catch(() => undefined);
    return next;
  };
  const asFolder = (record: { id: string; path: string; displayName: string }) => ({
    displayName: record.displayName,
    path: record.path,
    rootId: record.id,
  });
  const recorded = async (threadId: string): Promise<HostScratchFolder | null> => {
    const { roots } = await store.workspaceRoots({ operation: 'scratch-of-thread', threadId });
    return roots[0] ? asFolder(roots[0]) : null;
  };
  const roots: HostScratchFolderRoots = {
    add: ({ make, signal, threadId }) =>
      serially(async () => {
        signal.throwIfAborted();
        const own = await recorded(threadId);
        if (own) {
          folders.set(own.rootId, own.path);
          return own;
        }
        if ((await store.workspaceRoots({ operation: 'list-open' })).roots.length > 0) {
          return null;
        }
        const path = await make();
        const [root] = (
          await store.workspaceRoots({
            operation: 'register-scratch',
            root: {
              canonicalPath: await realpath(path),
              displayName: basename(path),
              path,
              preferredId: randomUUID(),
            },
            threadId,
          })
        ).roots;
        if (!root) {
          throw new Error('The store recorded no scratch folder');
        }
        folders.set(root.id, root.path);
        return asFolder(root);
      }),
    forget: (threadId) =>
      serially(async () => {
        const [root] = (await store.workspaceRoots({ operation: 'forget-scratch', threadId }))
          .roots;
        if (!root) {
          return null;
        }
        folders.delete(root.id);
        return { path: root.path };
      }),
    // As the registry does, without its mounts: the folder moves, then its record turns.
    promote: ({ move, threadId }) =>
      serially(async () => {
        const own = await recorded(threadId);
        if (!own) {
          throw new Error('The thread has no scratch folder');
        }
        const path = await move(own.path);
        const [root] = (
          await store.workspaceRoots({
            operation: 'scratch-to-project',
            root: { canonicalPath: await realpath(path), displayName: basename(path), path },
            rootId: own.rootId,
          })
        ).roots;
        if (!root) {
          throw new Error('The store turned no root');
        }
        folders.set(root.id, root.path);
        return asFolder(root);
      }),
    read: recorded,
  };
  let names = 0;
  const platform: HostPlatform = {
    // As the desktop admission does: each run's tools and configuration name its bound folder,
    // and a run with no folder of its own works in the open folder.
    admitRun: async (request) => {
      requests.push(request);
      const bound = request.workspaceBinding?.operatingRootId ?? OPEN;
      const tools = fileTools(bound);
      return {
        configuration: request.workspaceBinding?.operatingRootId
          ? { boundWorkspaceRootId: bound }
          : {},
        model,
        snapshot: {
          configuration: {},
          maxSteps: 6,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      };
    },
    close: async () => undefined,
    readPermissionPolicy: () => ({
      policies: { ...DEFAULT_PERMISSION_POLICIES, edit: 'allow', read: 'allow' },
      yolo: false,
    }),
    scratchFolders: hostScratchFolders({
      directory: scratch,
      name: (taken) => {
        let name = '';
        do {
          names += 1;
          name = `quiet-otter-${names}`;
        } while (taken.has(name));
        return name;
      },
      pickFolder: async () => {
        harness.picked += 1;
        return harness.picks.shift() ?? null;
      },
      rename: async (from, to) => {
        harness.moveStarted?.();
        await harness.holdMove;
        if (harness.failMove) {
          throw harness.failMove;
        }
        await rename(from, to);
      },
      roots,
      store,
      trash: async (path) => {
        if (harness.failTrash) {
          throw harness.failTrash;
        }
        await rename(path, join(trash, basename(path)));
        trashed.push(path);
      },
    }),
    // As the desktop's binding authority does: a folder hint that is not where the root is
    // mounted is refused (BST-2516).
    validateWorkspaceBinding: async ({ binding }) => {
      const mounted = folders.get(binding.operatingRootId ?? '');
      if (binding.operatingRootPath && mounted && binding.operatingRootPath !== mounted) {
        throw new Error(`The binding names ${binding.operatingRootPath}, not ${mounted}`);
      }
    },
  };
  // Core's own deletion is what these tests cover; the store's purge needs the indexer.
  const core = await HostCore.open(crashableStorePort(store).port, platform, () => () => undefined);
  cleanup.push(async () => {
    await core.close();
    await store.close();
    await rm(base, { force: true, recursive: true });
  });
  return {
    /** The test's own folder, outside `<userData>`: where a person keeps projects. */
    base,
    core,
    /**
     * Records `path` as a folder of the person's under `rootId` and mounts it there, as the
     * registry does when the person opens it, or locates it after it moved (the record keeps its
     * id and is pointed at the new place).
     */
    folder: async (rootId: string, path: string): Promise<void> => {
      await store.workspaceRoots({
        operation: 'register',
        repin: true,
        root: { canonicalPath: path, displayName: basename(path), path, preferredId: rootId },
      });
      folders.set(rootId, path);
    },
    harness,
    /** Opens a folder in the workspace, as the person does. */
    open: async (): Promise<void> => {
      folders.set(OPEN, open);
      await store.workspaceRoots({
        operation: 'register',
        root: { canonicalPath: open, displayName: 'project', path: open, preferredId: OPEN },
      });
    },
    /** The text of `name` in the folder `rootId` names. */
    read: (rootId: string, name: string): Promise<string> =>
      readFile(join(folders.get(rootId) ?? '', name), 'utf8'),
    requests,
    run: async (threadId: string, prompt: string): Promise<string> =>
      (await core.startRun({ commandId: randomUUID(), modelId: 'scripted', prompt, threadId }))
        .runId,
    scratchDirectory: scratch,
    /** The folders made under `<userData>/scratch`, by name. */
    scratchFolders: async (): Promise<string[]> => (await readdir(scratch).catch(() => [])).sort(),
    store,
    thread: async (): Promise<string> =>
      (await core.startThread({ commandId: randomUUID() })).threadId,
    /** What the system Trash holds, by name. */
    trashContents: async (): Promise<string[]> => (await readdir(trash)).sort(),
    trashed,
  };
}
