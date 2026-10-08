// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { HostCore, type HostPlatform } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
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
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';
import { desktopCredentialStoreSelection } from '../secrets';

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

test('actual Core binding commands reach the live Main owner over the private platform port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-main-binding-port-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const connection = mainPlatformConnection(mainPort);
  const cleanup: (() => Promise<void>)[] = [];
  const operatingRootId = randomUUID();
  const futureRootId = randomUUID();
  let retainedRevoked = false;
  const revalidateRetained = vi.fn(async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (retainedRevoked) {
      throw new Error('Retained pinned mount was revoked');
    }
  });
  const validate = vi.fn<NonNullable<HostPlatform['validateWorkspaceBinding']>>(
    async ({ binding, signal }) => {
      signal.throwIfAborted();
      if (binding.operatingRootId !== operatingRootId && binding.operatingRootId !== futureRootId) {
        throw new Error('Live catalog refused the unknown root');
      }
    }
  );
  const capabilities = {
    // Production's Main MCP stores; this scenario configures no MCP server.
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
    readConfiguration: async (): Promise<DesktopPlatformSelection> => ({
      close: async () => undefined,
      configuration: { model: 'gpt-4o-mini', provider: 'openai' },
      contextWindow: 128_000,
      durableConfiguration: {},
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
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      revalidateWorkspace: revalidateRetained,
      tools: {},
      toolTimeoutMs: 5000,
      workspace: {
        boundWorkspaceRootId: operatingRootId,
        roots: [{ displayName: 'Catalog workspace', path: root, rootId: operatingRootId }],
      },
    }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    resolveProviderAuth: async () => ({
      apiKey: 'synthetic-main-binding-key',
      kind: 'api_key' as const,
    }),
    validateWorkspaceBinding: validate,
  };
  const main = serveDesktopPlatform(connection, capabilities);
  let store: StateStore | undefined;
  let platform: HostPlatform | undefined;
  let core: HostCore | undefined;
  try {
    store = await StateStore.open(root);
    // Production launches the host on the profile credential store Settings writes
    // (a private file in test mode); the provider key resolves there, in Node.
    const credentialStore = desktopCredentialStoreSelection(root, true);
    const settings = createHostCredentials({ selection: credentialStore });
    await settings.secrets().saveKey('openai', 'synthetic-main-binding-key');
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
      { credentialStore }
    );
    core = await HostCore.open(store, platform, () => () => undefined);
    const { threadId } = await core.startThread({ commandId: randomUUID() });
    const request = {
      commandId: randomUUID(),
      patch: { operatingRootDisplayName: 'Catalog workspace', operatingRootId },
      threadId,
    };
    await expect(core.updateWorkspaceBinding(request)).resolves.toEqual({ accepted: true });
    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]?.[0]).toMatchObject({ binding: request.patch, threadId });
    await core.updateWorkspaceBinding(request);
    expect(validate).toHaveBeenCalledOnce();
    await expect(
      core.updateWorkspaceBinding({
        commandId: randomUUID(),
        patch: { operatingRootDisplayName: 'Forged view hint', operatingRootId: randomUUID() },
        threadId,
      })
    ).rejects.toThrow();
    expect(core.readWorkspaceBinding(threadId)).toEqual({ binding: request.patch });
    const admitRun = platform.admitRun;
    if (!admitRun) {
      throw new Error('Production admission capability was not forwarded');
    }
    const admission = await admitRun({
      modelId: 'gpt-4o-mini',
      signal: new AbortController().signal,
      threadId,
      workspaceBinding: request.patch,
    });
    const retireAdmission = admission.close;
    if (!retireAdmission) {
      throw new Error('Production admission has no retirement owner');
    }
    try {
      expect(admission.configuration).toMatchObject({
        boundWorkspaceRootId: operatingRootId,
        workspaceRoots: [{ rootId: operatingRootId }],
      });
      const validator = platform.validateWorkspaceBinding;
      if (!validator) {
        throw new Error('Main validator was not forwarded');
      }
      const freshCount = validate.mock.calls.length;
      await validator({ binding: request.patch, signal: new AbortController().signal, threadId });
      expect(revalidateRetained).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledTimes(freshCount);
      retainedRevoked = true;
      await expect(
        validator({ binding: request.patch, signal: new AbortController().signal, threadId })
      ).rejects.toThrow();
      expect(validate).toHaveBeenCalledTimes(freshCount);
      await validator({
        binding: { operatingRootDisplayName: 'Future workspace', operatingRootId: futureRootId },
        signal: new AbortController().signal,
        threadId,
      });
      expect(validate).toHaveBeenCalledTimes(freshCount + 1);
      expect(revalidateRetained).toHaveBeenCalledTimes(2);
    } finally {
      await retireAdmission();
    }
  } finally {
    if (core) {
      await core.close();
    } else {
      await platform?.close();
    }
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
