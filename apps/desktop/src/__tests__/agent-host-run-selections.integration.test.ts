// @vitest-environment node
/**
 * BST-1932: Main keys each platform selection by the run it admitted. A child
 * borrowing its parent's admission reaches Main under that run (here, through
 * its turn-start snapshot of the admitted roots), the thread's next run (or a
 * follow-up admitted for its root) admits beside a held selection, and each
 * selection is released once. The recorded defect: AT-06's background worker
 * reached Main after its root run's selection, keyed by thread, was gone
 * ("Platform thread has no admitted capabilities").
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { HostPlatform } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import {
  type DesktopPlatformSelection,
  serveDesktopPlatform,
} from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createSnapshotService } from '../assistant-server/snapshot-service';
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

/** A selection whose admitted roots report the run each read was served for. */
function selection(close: () => Promise<void>, served: () => void): DesktopPlatformSelection {
  return {
    close,
    configuration: { model: 'gpt-4o-mini', provider: 'openai' },
    contextWindow: 128_000,
    durableConfiguration: {},
    freshWorkspaceRoots: async () => {
      served();
      return [];
    },
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
  };
}

test('Main keys each admission by its run: a borrowing child reaches the admitting run, the thread’s next run admits beside it, and each selection is released once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-selections-'));
  const snapshots = createSnapshotService({
    runner: async () => {
      throw new Error('No admitted root is snapshotted in this scenario');
    },
    snapshotsBaseDir: join(root, 'shadow'),
  });
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const connection = mainPlatformConnection(mainPort);
  const cleanup: (() => Promise<void>)[] = [];
  const releases: string[] = [];
  const served: string[] = [];
  const main = serveDesktopPlatform(connection, {
    // Production's Main MCP stores; this scenario configures no MCP server.
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
    readConfiguration: async (request) =>
      selection(
        async () => {
          releases.push(request.runId);
        },
        () => served.push(request.runId)
      ),
    // Gap 17's import capability; this proof reads no legacy memory.
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
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
        modelId: 'gpt-4o-mini',
        runId,
        signal: new AbortController().signal,
        threadId: 'root-thread',
      });
    const first = await admit('root-run-1');
    const capture = first.captureTurnBoundary;
    if (!capture) {
      throw new Error('The admission has no turn boundary capture');
    }
    // A child borrowing the root run's admission starts its turn under its own run and thread.
    const childTurn = () =>
      capture({ boundary: 'turn-start', runId: 'child-run', threadId: 'child-thread' });
    expect(await childTurn()).toEqual([]);
    expect(served).toEqual(['root-run-1']);
    // The thread's next run, or a follow-up admitted for its root, admits beside it.
    const second = await admit('root-run-2');
    await second.close?.();
    expect(releases).toEqual(['root-run-2']);
    // The first selection still serves its borrowers until it is released, once.
    expect(await childTurn()).toEqual([]);
    expect(served).toEqual(['root-run-1', 'root-run-1']);
    await first.close?.();
    await first.close?.();
    expect(releases).toEqual(['root-run-2', 'root-run-1']);
    await expect(childTurn()).rejects.toThrow('Platform run has no admitted capabilities');
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
