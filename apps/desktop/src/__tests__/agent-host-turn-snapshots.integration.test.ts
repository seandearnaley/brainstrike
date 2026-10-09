// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { HostPlatform, HostRunAdmission } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import {
  type DesktopPlatformCapabilities,
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { execFileSnapshotGitRunner } from '../assistant-server/snapshot-git';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../assistant-server/snapshot-repository';
import { createSnapshotService, type SnapshotService } from '../assistant-server/snapshot-service';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { desktopCredentialStoreSelection } from '../secrets';
import { desktopAppPaths } from './fixtures/desktop-host-profile';

/** Actual Node ports expose the same MessageEvent contract as the utility transport. */
class UtilityPort extends EventEmitter implements PlatformMessagePort {
  constructor(private readonly port: MessagePort) {
    super();
    port.on('message', (data: unknown) => this.emit('message', { data }));
    port.on('close', () => this.emit('close'));
  }
  start(): void {
    this.port.start();
  }
  postMessage(message: unknown): void {
    this.port.postMessage(message);
  }
  close(): void {
    this.port.close();
  }
}

type CaptureTurnBoundary = NonNullable<HostRunAdmission['captureTurnBoundary']>;

/**
 * The production Node admission over the private port to Main's platform,
 * whose selection admits `roots`. The admission is retired before `body`'s
 * returned promise settles only if `body` retires it.
 */
async function withAdmittedRun(
  roots: readonly { readonly path: string; readonly rootId: string }[],
  workspaceSnapshots: DesktopPlatformCapabilities['workspaceSnapshots'],
  body: (run: {
    readonly admission: HostRunAdmission;
    readonly capture: CaptureTurnBoundary;
    readonly platform: HostPlatform;
    readonly threadId: string;
  }) => Promise<void>,
  resolveWorkspaceRoot?: DesktopPlatformCapabilities['resolveWorkspaceRoot']
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-turn-snapshots-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const connection = mainPlatformConnection(mainPort);
  const cleanup: (() => Promise<void>)[] = [];
  const main = serveDesktopPlatform(connection, {
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
    readConfiguration: async (): Promise<DesktopPlatformSelection> => ({
      close: async () => undefined,
      configuration: { model: 'gpt-4o-mini', provider: 'openai' },
      contextWindow: 128_000,
      durableConfiguration: {},
      freshWorkspaceRoots: async () =>
        roots.map(({ path, rootId }) => ({ displayName: rootId, path, rootId })),
      inputTokenLimit: 24_000,
      maxSteps: 5,
      memory: {
        options: {
          lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
          workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
        },
        settings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: false,
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: false,
          },
        },
      },
      nativeRuntime: { provider: 'openai', workspaceRoots: [] },
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      tools: {},
      toolTimeoutMs: 5000,
    }),
    // Gap 17's import capability; this proof reads no legacy memory.
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
    ...(resolveWorkspaceRoot ? { resolveWorkspaceRoot } : {}),
  });
  let store: StateStore | undefined;
  let platform: Awaited<ReturnType<typeof createHostPlatform>> | undefined;
  try {
    store = await StateStore.open(root);
    const credentialStore = desktopCredentialStoreSelection(root, true);
    const settings = createHostCredentials({ selection: credentialStore });
    await settings.secrets().saveKey('openai', 'synthetic-turn-snapshot-key');
    await settings.close();
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    platform = await createHostPlatform(
      { lifetime: 'app', root },
      {
        register: async (close) => {
          cleanup.push(close);
        },
        signal: new AbortController().signal,
        store,
      },
      { appPaths: desktopAppPaths(root), credentialStore }
    );
    const admitRun = platform.admitRun;
    if (!admitRun) {
      throw new Error('Production admission capability was not forwarded');
    }
    const threadId = randomUUID();
    const admission = await admitRun({
      modelId: 'gpt-4o-mini',
      runId: randomUUID(),
      signal: new AbortController().signal,
      threadId,
    });
    const capture = admission.captureTurnBoundary;
    if (!capture) {
      throw new Error('The desktop admission has no turn boundary capture');
    }
    await body({ admission, capture, platform, threadId });
  } finally {
    await platform?.close();
    await main.close();
    for (const close of cleanup.reverse()) {
      await close();
    }
    connection.dispose();
    mainPort.close();
    nodePort.close();
    await store?.close();
    await rm(root, { force: true, recursive: true });
  }
}

async function workspaceDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-turn-workspace-')));
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'a.txt'), 'before\n');
  return directory;
}

async function treeOf(
  service: SnapshotService,
  root: { readonly path: string; readonly rootId: string },
  oid: string
): Promise<ReadonlyMap<string, string>> {
  return await service.snapshotFileHashes(await service.ensureShadowRepo(root), oid);
}

test('a desktop host run snapshots its admitted roots at its start, and its start roots at its end after Main released it', async () => {
  const workspace = await workspaceDirectory();
  const snapshotsDir = await mkdtemp(join(tmpdir(), 'bs-m3-turn-shadow-'));
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: snapshotsDir,
  });
  const live = { path: workspace, rootId: 'live-root' };
  const missing = { path: join(workspace, 'unmounted'), rootId: 'missing-root' };
  try {
    await withAdmittedRun(
      [live, missing],
      () => service,
      async (run) => {
        const runId = randomUUID();
        const start = await run.capture({ boundary: 'turn-start', runId, threadId: run.threadId });
        expect(start).toEqual([
          {
            commitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
            rootId: 'live-root',
            rootPath: workspace,
          },
          {
            commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
            rootId: 'missing-root',
            rootPath: missing.path,
          },
        ]);
        const startOid = start[0]?.commitOid ?? '';
        expect(startOid).not.toBe(FAILED_SNAPSHOT_CAPTURE_OID);

        await writeFile(join(workspace, 'src', 'a.txt'), 'after\n');
        await writeFile(join(workspace, 'src', 'b.txt'), 'added\n');
        // The production order: a run's admission closes before its terminal rows.
        await run.admission.close?.();

        const end = await run.capture({
          boundary: 'turn-end',
          roots: start.map(({ rootId, rootPath }) => ({ rootId, rootPath })),
          runId,
          threadId: run.threadId,
        });
        expect(end).toEqual([
          {
            commitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
            rootId: 'live-root',
            rootPath: workspace,
          },
          {
            commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
            rootId: 'missing-root',
            rootPath: missing.path,
          },
        ]);
        const endOid = end[0]?.commitOid ?? '';
        const before = await treeOf(service, live, startOid);
        const after = await treeOf(service, live, endOid);
        expect([...before.keys()]).toEqual(['src/a.txt']);
        expect([...after.keys()].sort()).toEqual(['src/a.txt', 'src/b.txt']);
        expect(after.get('src/a.txt')).not.toBe(before.get('src/a.txt'));
        // The snapshots belong to the host thread's own ref, which GC inventories.
        expect(await service.listSnapshotThreadIds(await service.ensureShadowRepo(live))).toEqual([
          run.threadId,
        ]);
      }
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
    await rm(snapshotsDir, { force: true, recursive: true });
  }
});

test('a desktop host run without a snapshot owner fails its capture visibly', async () => {
  const workspace = await workspaceDirectory();
  try {
    await withAdmittedRun([{ path: workspace, rootId: 'live-root' }], undefined, async (run) => {
      await expect(
        run.capture({ boundary: 'turn-start', runId: randomUUID(), threadId: run.threadId })
      ).rejects.toThrow('This desktop has no workspace snapshot owner');
      await run.admission.close?.();
    });
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test('a desktop host rewind restores a turn over the private port, and its redo undoes it', async () => {
  const workspace = await workspaceDirectory();
  const snapshotsDir = await mkdtemp(join(tmpdir(), 'bs-m3-rewind-shadow-'));
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: snapshotsDir,
  });
  const live = { path: workspace, rootId: 'live-root' };
  try {
    await withAdmittedRun(
      [live],
      () => service,
      async (run) => {
        const rewindFiles = run.platform.rewindFiles;
        if (!rewindFiles) {
          throw new Error('The desktop host platform has no rewind restore owner');
        }
        const [start] = await run.capture({
          boundary: 'turn-start',
          runId: randomUUID(),
          threadId: run.threadId,
        });
        if (!start) {
          throw new Error('The turn start captured no root');
        }
        await writeFile(join(workspace, 'src', 'a.txt'), 'after\n');
        await writeFile(join(workspace, 'src', 'b.txt'), 'added\n');
        await run.admission.close?.();

        const targets = [start];
        const { previewId } = await rewindFiles.preview({ targets, threadId: run.threadId });
        expect(await rewindFiles.drift({ previewId, threadId: run.threadId })).toEqual([]);
        const outcomes = await rewindFiles.apply({
          previewId,
          rewindId: 'rewind-1',
          targets,
          threadId: run.threadId,
        });
        expect(outcomes).toEqual(
          expect.arrayContaining([
            { path: 'src/a.txt', rootId: 'live-root', status: 'restored' },
            { path: 'src/b.txt', rootId: 'live-root', status: 'deleted' },
          ])
        );
        expect(await readFile(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('before\n');

        const redo = { rewindId: 'rewind-1', targets, threadId: run.threadId };
        expect(await rewindFiles.redoConflicts(redo)).toEqual([]);
        await rewindFiles.redo({ ...redo, acknowledged: [] });
        expect(await readFile(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('after\n');
        expect(await readFile(join(workspace, 'src', 'b.txt'), 'utf8')).toBe('added\n');
      },
      async (rootId) => {
        if (rootId !== live.rootId) {
          throw new Error('The workspace root is no longer mounted');
        }
        return workspace;
      }
    );
  } finally {
    await rm(workspace, { force: true, recursive: true });
    await rm(snapshotsDir, { force: true, recursive: true });
  }
});
