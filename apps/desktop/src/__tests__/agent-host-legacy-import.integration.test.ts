// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import {
  type AgentHost,
  attachAgentHost,
  authenticateHostClient,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import { serveDesktopPlatform } from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';

/** Same public MessageEvent shape as the Electron utility port, backed by real Node ports. */
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

/** Main's own client shape: a private port the host binds as the desktop origin. */
async function desktopClient(host: AgentHost): Promise<HostClient> {
  const channel = new MessageChannel();
  const mainSide = new UtilityPort(channel.port1);
  const hostSide = new UtilityPort(channel.port2);
  host.bindClientConnection(mainPlatformConnection(hostSide), 'desktop-ui');
  const closed = new Promise<void>((resolve) => mainSide.once('close', () => resolve()));
  return await authenticateHostClient(
    mainPlatformConnection(mainSide),
    host.record,
    async () => {
      mainSide.close();
      hostSide.close();
    },
    closed
  );
}

/** Settles after a macrotask with whether `promise` is still pending. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const observe = (): void => {
    settled = true;
  };
  promise.then(observe, observe);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return !settled;
}

const LEGACY_KEY = JSON.stringify({ key: 'sk-legacy-openrouter', type: 'api_key' });

/**
 * A host launched while the desktop's retired store still holds entries starts
 * with the store it has (its MCP runtime included), holds credential use, and
 * releases it when the launching desktop's import lands over its private client.
 */
test('a pending legacy import follows host readiness and releases held credential use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-legacy-import-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const credentialFile = join(root, 'credentials.json');
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    mcp: createDesktopMcpPlatformCapabilities(new RemoteMcpRuntime()),
    readConfiguration: async () => {
      throw new Error('This scenario admits no run');
    },
    readLegacyMemory: async () => ({ resource: null, resourceObservations: false }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  });
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  let socket: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    // Readiness does not wait for the import.
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, {
        credentialStore: { kind: 'file', path: credentialFile },
        legacyImportPending: true,
      })
    );
    desktop = await desktopClient(host);
    const ui = desktop;
    const status = ui.request('auth/status', { provider: 'openai-codex' });
    expect(await stillPending(status)).toBe(true);

    socket = await attachAgentHost(host.record);
    await expect(
      socket.request('auth/import-legacy', {
        entries: [{ account: 'openrouter', value: LEGACY_KEY }],
      })
    ).rejects.toThrow("desktop's private client");
    expect(await stillPending(status)).toBe(true);

    await expect(
      ui.request('auth/import-legacy', { entries: [{ account: 'openrouter', value: LEGACY_KEY }] })
    ).resolves.toEqual({ alreadyPresent: 0, migrated: 1 });
    await expect(status).resolves.toEqual({ state: 'disconnected' });
    expect(JSON.parse(await readFile(credentialFile, 'utf8'))).toMatchObject({
      secrets: { openrouter: LEGACY_KEY },
    });
  } finally {
    await socket?.close();
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  }
});
