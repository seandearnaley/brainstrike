// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { Schema } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import {
  attachHostCommandSessions,
  disposeDesktopAndHostCommandSessionsForRoot,
  hostCommandSessions,
} from '../agent-host-platform/host-command-session-client';
import {
  disposeHostTools,
  serveHostCommandSessions,
} from '../agent-host-platform/host-tool-process';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';
import { createCommandSessionManager } from '../assistant-server/command-session-manager';
import {
  createCommandSessionIpcHandlers,
  withHostCommandSessions,
} from '../command-session-ipc-handlers';

/** Real Node ports with the Electron utility port's public MessageEvent shape. */
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
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
function selection(root: string) {
  return Schema.decodeUnknownSync(PlatformSelectionSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })({
    configuration: { model: 'gpt-6-sol', provider: 'openai' },
    contextWindow: 32_000,
    durableConfiguration: {},
    inputTokenLimit: 24_000,
    maxSteps: 3,
    memory: {
      options: {
        lastMessages: 1,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 1000,
          modelTarget: 'auto',
          observationTokens: 1000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: null,
          enabled: false,
          messageRange: 0,
          scope: 'thread',
          topK: 1,
        },
      },
    },
    nativeRuntime: {
      provider: 'openai',
      workspaceRoots: [{ displayName: 'A', path: root, rootId: 'root-a' }],
    },
    resourceId: 'workspace',
    tools: {
      brainstrike_manageCommandSession: {
        description: 'Manage a command session',
        identity: NATIVE_TOOL_ID.manageCommandSession,
        inputSchema: { type: 'object' },
        permissionToolId: NATIVE_TOOL_ID.manageCommandSession,
        risk: 'execute',
      },
    },
    toolTimeoutMs: 5000,
  });
}
const execution: HostToolContext = {
  edits: { track: async () => Promise.reject(new Error('A command session never edits')) },
  runId: 'host-run',
  signal: new AbortController().signal,
  state: { entries: () => [], read: async () => undefined, update: async () => undefined },
  threadId: 'host-thread',
  toolCallId: 'session-call',
};
test('a host run’s command session lives in the agent host and Main’s Terminal panel lists and stops it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-session-')));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const channel = new MessageChannel();
  const hostSide = mainPlatformConnection(new UtilityPort(channel.port1));
  const mainSide = mainPlatformConnection(new UtilityPort(channel.port2));
  serveHostCommandSessions(hostSide);
  hostSide.listen();
  attachHostCommandSessions(mainSide);
  mainSide.listen();
  cleanups.push(() => {
    mainSide.dispose();
    hostSide.dispose();
    channel.port1.close();
    channel.port2.close();
  });
  cleanups.push(() => disposeHostTools());
  // The host starts the session in its own process, inside the run's admitted root.
  const request = vi.fn(async (method: string) => {
    if (method !== 'admission/fresh-roots') {
      throw new Error(`Unexpected Main request ${method}`);
    }
    return [{ displayName: 'A', path: root, rootId: 'root-a' }];
  });
  const manage = desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots'),
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  })['brainstrike_manageCommandSession'];
  if (!manage) {
    throw new Error('manageCommandSession was not built for the host');
  }
  const started = (await manage.execute(
    { operation: { action: 'start', command: 'sleep 30' } },
    execution
  )) as {
    readonly cwd: string;
    readonly id: string;
    readonly status: string;
  };
  expect(started).toMatchObject({ cwd: root, rootId: 'root-a', status: 'running' });
  // Main holds no session of its own; its panel reaches the host's over the connection.
  const panel = withHostCommandSessions(
    createCommandSessionIpcHandlers({
      manager: createCommandSessionManager({ resolver: { listRoots: async () => [] } }),
    }),
    hostCommandSessions
  );
  await expect(panel.list({ rootId: 'root-a' })).resolves.toEqual({
    ok: true,
    value: {
      rootId: 'root-a',
      sessions: [expect.objectContaining({ id: started.id, status: 'running' })],
    },
  });
  await expect(panel.stop({ rootId: 'root-a', sessionId: started.id })).resolves.toEqual({
    ok: true,
  });
  await expect(panel.list({ rootId: 'root-a' })).resolves.toMatchObject({
    ok: true,
    value: { sessions: [expect.objectContaining({ id: started.id, status: 'exited' })] },
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'admission/fresh-roots',
    'admission/fresh-roots',
  ]);
});
test('disconnecting a root in Main stops and forgets the host run sessions there', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-host-session-root-')));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const channel = new MessageChannel();
  const hostSide = mainPlatformConnection(new UtilityPort(channel.port1));
  const mainSide = mainPlatformConnection(new UtilityPort(channel.port2));
  serveHostCommandSessions(hostSide);
  hostSide.listen();
  attachHostCommandSessions(mainSide);
  mainSide.listen();
  cleanups.push(() => {
    mainSide.dispose();
    hostSide.dispose();
    channel.port1.close();
    channel.port2.close();
  });
  cleanups.push(() => disposeHostTools());
  const manage = desktopHostSharedTools({
    freshRoots: async () => [{ displayName: 'A', path: root, rootId: 'root-a' }],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request: vi.fn(),
    resolveTavilyApiKey: async () => undefined,
    selected: selection(root),
    threadId: 'host-thread',
  })['brainstrike_manageCommandSession'];
  if (!manage) {
    throw new Error('manageCommandSession was not built for the host');
  }
  await manage.execute({ operation: { action: 'start', command: 'sleep 30' } }, execution);
  const panel = withHostCommandSessions(
    createCommandSessionIpcHandlers({
      manager: createCommandSessionManager({ resolver: { listRoots: async () => [] } }),
    }),
    hostCommandSessions
  );
  await expect(panel.list({ rootId: 'root-a' })).resolves.toMatchObject({
    value: { sessions: [expect.objectContaining({ status: 'running' })] },
  });
  // The disconnect path Main's root registry and fs:removeRoot take.
  await expect(disposeDesktopAndHostCommandSessionsForRoot('root-a')).resolves.toBe(1);
  await expect(panel.list({ rootId: 'root-a' })).resolves.toEqual({
    ok: true,
    value: { rootId: 'root-a', sessions: [] },
  });
});
