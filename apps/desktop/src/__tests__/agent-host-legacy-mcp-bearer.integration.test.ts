// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import {
  type AgentHost,
  authenticateHostClient,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { mcpBearerCredentialStorageKey } from '@brainstrike/host-capabilities/mcp/bearer-credential';
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
import { desktopAppPaths, writeDesktopMcpConfig } from './fixtures/desktop-host-profile';

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

const LEGACY_BEARER = 'legacy-only-mcp-bearer-fixture';
const configuredServerId = parseConfiguredMcpServerId('fixture.legacy-bearer');

/** The bearer credential state Main mirrors for Settings, before any connect. */
function credentialState(runtime: RemoteMcpRuntime): string | undefined {
  const server = runtime.host
    .snapshot()
    .servers.find((candidate) => candidate.configuredServerId === configuredServerId);
  return server?.auth?.type === 'bearer' ? server.auth.credentialState : undefined;
}

/**
 * First launch after the safeStorage-to-keyring upgrade: an MCP server's bearer
 * key exists only in the retired store. The host becomes ready without waiting
 * for MCP, the server connects after readiness, and its bearer read waits for
 * the desktop's import instead of reading the store before the key arrives.
 */
test('a legacy-only MCP bearer key authenticates its server on the first launch', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-legacy-mcp-bearer-'));
  const fixture = await startStatefulMcpHostServer();
  const reference = { id: randomUUID(), store: 'mcp-credentials' as const };
  const mcpRuntime = new RemoteMcpRuntime();
  await writeDesktopMcpConfig(root, [
    {
      auth: { credential: reference, type: 'bearer' },
      name: configuredServerId,
      protocol: 'legacy',
      startup: 'automatic',
      transport: 'streamable-http',
      url: fixture.url,
    },
  ]);
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    mcp: createDesktopMcpPlatformCapabilities(mcpRuntime),
    readConfiguration: async () => {
      throw new Error('This scenario admits no run');
    },
    readLegacyMemory: async () => ({ resource: null, resourceObservations: false }),
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  });
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, {
        appPaths: desktopAppPaths(root),
        credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
        legacyImportPending: true,
      })
    );
    desktop = await desktopClient(host);
    // Readiness came first; nothing has reached the server, with or without a key.
    expect(fixture.requests).toEqual([]);

    await expect(
      desktop.request('auth/import-legacy', {
        entries: [{ account: mcpBearerCredentialStorageKey(reference), value: LEGACY_BEARER }],
      })
    ).resolves.toEqual({ alreadyPresent: 0, migrated: 1 });

    // Settings' status, mirrored from the host's first configuration, already
    // names the imported key: the bearer read waited for it instead of
    // recording a missing credential before it arrived.
    await expect.poll(() => credentialState(mcpRuntime), { timeout: 15_000 }).toBe('stored');
    const server = await mcpRuntime.host.control({ action: 'connect', configuredServerId });
    expect(server.auth).toEqual({ credentialState: 'stored', type: 'bearer' });
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(new Set(fixture.requests.map(({ authorization }) => authorization))).toEqual(
      new Set([`Bearer ${LEGACY_BEARER}`])
    );
  } finally {
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await fixture.close();
    await rm(root, { force: true, recursive: true });
  }
});
