// @vitest-environment node
/**
 * BST-1930 stage e: the agent host composes each run's admission from the
 * facts Main reads for it, and Main holds no selection. The catalog decides
 * whether a model may run; Main's live roots are what the run admits; a child
 * borrowing its parent's admission snapshots those roots at its turn start,
 * from the roots the host sends; and the thread's next run admits beside it.
 * Main is never asked to admit (`platform/admit`).
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { type HostPlatform, writeHostPermissionPolicy } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createHostPlatform } from '../agent-host-platform-entry';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../assistant-server/snapshot-repository';
import { createSnapshotService } from '../assistant-server/snapshot-service';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { desktopCredentialStoreSelection } from '../secrets';
import { desktopAppPaths } from './fixtures/desktop-host-profile';
import { serveInProcessDesktopPlatform } from './fixtures/in-process-desktop-platform';

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

const MODEL = { model: 'gpt-6-sol', provider: 'openai' } as const;

/** The intent the composer captured: no native tools, memory off, nothing to scan. */
const INTENT = {
  enabledNativeToolIds: [],
  memoryOptions: {
    lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
    workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
  },
  memorySettings: {
    ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
    observationalMemory: {
      ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
      enabled: false,
    },
    semanticRecall: { ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall, enabled: false },
  },
  modelConfiguration: MODEL,
  permissionPolicy: { policies: DEFAULT_PERMISSION_POLICIES, yolo: false },
  skillsPreference: { disabledSkillKeys: [], masterEnabled: false },
  workspaceInstructionsPreference: { masterEnabled: false, oversizedOptInByRootId: {} },
};

/** Main's reads for this profile: one live root and a catalog whose model the test toggles. */
function mainReads(
  rootPath: string,
  catalog: { enabled: boolean },
  reads: string[]
): DesktopAdmissionReads {
  return {
    acquireWorkspace: () => Promise.reject(new Error('This scenario binds no workspace')),
    catalogModel: async (target) => {
      reads.push(`catalog:${target.provider}::${target.model}`);
      return { isEnabled: catalog.enabled, providerId: target.provider };
    },
    enabledObservers: async () => [],
    liveWorkspaceRoots: async () => {
      reads.push('roots');
      return [{ displayName: 'project', path: rootPath, rootId: 'project-root' }];
    },
    memoryVectors: async () => undefined,
    worktreesAvailable: async () => false,
  };
}

test('the host admits each run from Main’s reads: the catalog decides, Main’s live roots are admitted, a borrowing child snapshots them, and Main admits nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-selections-'));
  const project = join(root, 'project');
  await mkdir(project);
  const snapshots = createSnapshotService({
    runner: async () => {
      throw new Error('The shadow store is unavailable in this scenario');
    },
    snapshotsBaseDir: join(root, 'shadow'),
  });
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const connection = mainPlatformConnection(mainPort);
  const cleanup: (() => Promise<void>)[] = [];
  const catalog = { enabled: false };
  const reads: string[] = [];
  const admitted: string[] = [];
  connection.onRequest('platform/admit', () => {
    admitted.push('platform/admit');
    throw new Error('Main admits no run');
  });
  const main = serveInProcessDesktopPlatform(connection, {
    admission: mainReads(project, catalog, reads),
    // Production's Main MCP stores; this scenario configures no MCP server.
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
    workspaceSnapshots: () => snapshots,
  });
  let store: StateStore | undefined;
  let platform: HostPlatform | undefined;
  try {
    store = await StateStore.open(root);
    const credentialStore = desktopCredentialStoreSelection(root, true);
    const settings = createHostCredentials({ selection: credentialStore });
    await settings.secrets().saveKey('openai', 'synthetic-run-selection-key');
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
    const admit = (runId: string) =>
      admitRun({
        configuration: INTENT,
        modelId: `${MODEL.provider}::${MODEL.model}`,
        runId,
        signal: new AbortController().signal,
        threadId: 'root-thread',
      });
    // The catalog decides: a disabled model is refused before anything is admitted.
    await expect(admit('refused-run')).rejects.toThrow('The selected catalog model is disabled');
    expect(reads).toEqual(['catalog:openai::gpt-6-sol']);
    catalog.enabled = true;

    const first = await admit('root-run-1');
    expect(reads).toContain('roots');
    const capture = first.captureTurnBoundary;
    if (!capture) {
      throw new Error('The admission has no turn boundary capture');
    }
    // A child borrowing the root run's admission snapshots Main's live root at its turn start.
    const childTurn = () =>
      capture({ boundary: 'turn-start', runId: 'child-run', threadId: 'child-thread' });
    expect(await childTurn()).toEqual([
      { commitOid: FAILED_SNAPSHOT_CAPTURE_OID, rootId: 'project-root', rootPath: project },
    ]);
    // The thread's next run admits beside it; closing either leaves the other serving.
    const second = await admit('root-run-2');
    await second.close?.();
    expect(await childTurn()).toHaveLength(1);
    await first.close?.();
    await first.close?.();
    expect(admitted).toEqual([]);
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
    if (store) {
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
    }
    await rm(root, { force: true, recursive: true });
  }
});

/**
 * BST-1930 stage e: the host's StateStore holds the policy the user saved, and
 * the host's gate reads it there, before any run's captured intent. Main is
 * never asked for a policy.
 */
test('the host gates tools by the policy saved in its own StateStore, not Main’s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-saved-policy-'));
  const project = join(root, 'project');
  await mkdir(project);
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const connection = mainPlatformConnection(mainPort);
  const cleanup: (() => Promise<void>)[] = [];
  const asked: string[] = [];
  connection.onRequest('platform/policy', () => {
    asked.push('platform/policy');
    return null;
  });
  const main = serveInProcessDesktopPlatform(connection, {
    admission: mainReads(project, { enabled: true }, []),
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  let store: StateStore | undefined;
  let platform: HostPlatform | undefined;
  try {
    store = await StateStore.open(root);
    const credentialStore = desktopCredentialStoreSelection(root, true);
    const settings = createHostCredentials({ selection: credentialStore });
    await settings.secrets().saveKey('openai', 'synthetic-saved-policy-key');
    await settings.close();
    const saved = {
      enforce: true,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'deny' as const },
      policies: { edit: 'deny', execute: 'deny', mcp: 'ask', read: 'allow' } as const,
      yolo: false,
    };
    await writeHostPermissionPolicy(store, saved);
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
    const gate = {
      perToolOverrides: saved.perToolOverrides,
      policies: saved.policies,
      yolo: false,
    };
    // A thread with no run yet, and a run whose captured intent says otherwise.
    await expect(platform.readPermissionPolicy('root-thread')).resolves.toEqual(gate);
    const admitRun = platform.admitRun;
    if (!admitRun) {
      throw new Error('Production admission capability was not forwarded');
    }
    const admitted = await admitRun({
      configuration: INTENT,
      modelId: `${MODEL.provider}::${MODEL.model}`,
      runId: 'saved-policy-run',
      signal: new AbortController().signal,
      threadId: 'root-thread',
    });
    await expect(platform.readPermissionPolicy('root-thread')).resolves.toEqual(gate);
    await admitted.close?.();
    expect(asked).toEqual([]);
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
});
