// @vitest-environment node
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
  type HostClientOrigin,
  startAgentHost,
} from '@brainstrike/agent-host';
import type { McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import {
  DEFAULT_PERMISSION_POLICIES,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
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

/** A client on a private port the host binds with the given origin. */
async function hostClient(host: AgentHost, origin: HostClientOrigin): Promise<HostClient> {
  const channel = new MessageChannel();
  const clientSide = new UtilityPort(channel.port1);
  const hostSide = new UtilityPort(channel.port2);
  host.bindClientConnection(mainPlatformConnection(hostSide), origin);
  const closed = new Promise<void>((resolve) => clientSide.once('close', () => resolve()));
  return await authenticateHostClient(
    mainPlatformConnection(clientSide),
    host.record,
    async () => {
      clientSide.close();
      hostSide.close();
    },
    closed
  );
}

const configuredServerId = parseConfiguredMcpServerId('fixture.status');

function serverState(status: McpHostSnapshot): string | undefined {
  return status.servers.find((server) => server.configuredServerId === configuredServerId)?.state;
}

/**
 * Settings reads the MCP runtime's server status and runs lifecycle control on
 * the agent host (BST-1930 c5b). The real runtime connects a real server; the
 * desktop client parses every status it receives, and a public-socket client
 * reaches none of it.
 */
test('the desktop client reads, follows and controls MCP server status on the agent host', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-status-'));
  const fixture = await startStatefulMcpHostServer();
  const mcpRuntime = new RemoteMcpRuntime();
  await writeDesktopMcpConfig(root, [
    {
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
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
  });
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  let cli: HostClient | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, {
        appPaths: desktopAppPaths(root),
        credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
      })
    );
    const client = await hostClient(host, 'desktop-ui');
    desktop = client;
    const statusEvents: McpHostSnapshot[] = [];
    client.onMcpSettings((event: McpSettingsEvent) => {
      if (event.type === 'status') {
        statusEvents.push(event.status);
      }
    });
    const subscribed = await client.request('mcp/settings/subscribe', {});
    expect(subscribed.status.revision).toBeGreaterThanOrEqual(0);

    // The automatic server connects; its full status (catalog, negotiation) parses on receipt.
    await expect
      .poll(async () => serverState(await client.request('mcp/status/read', {})), {
        timeout: 20_000,
      })
      .toBe('connected');
    const connected = await client.request('mcp/status/read', {});
    expect(connected.servers).toEqual([
      expect.objectContaining({
        catalog: expect.objectContaining({
          tools: { tools: [expect.objectContaining({ name: 'host_lifecycle_probe' })] },
        }),
        configuredServerId,
        negotiated: expect.objectContaining({ era: 'legacy' }),
        state: 'connected',
      }),
    ]);
    // The subscription answered a revision and pushes every later one: the
    // connect lands in one or the other, whichever it raced.
    await expect
      .poll(() => [subscribed.status, ...statusEvents].map(serverState))
      .toContain('connected');

    // Lifecycle control runs on the host and its result follows on the stream.
    const disconnected = await client.request('mcp/server/control', {
      action: 'disconnect',
      configuredServerId,
    });
    expect(disconnected).toMatchObject({ configuredServerId, state: 'disconnected' });
    // (The disconnect reloads the config, so the automatic server then retries
    // against the fixture's spent session; the stream carries both.)
    await expect.poll(() => statusEvents.map(serverState)).toContain('disconnected');
    const latest = await client.request('mcp/status/read', {});
    expect(latest.revision).toBeGreaterThanOrEqual(statusEvents.at(-1)?.revision ?? 0);
    const revisions = statusEvents.map(({ revision }) => revision);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));

    // The same client follows the host's MCP presentations (BST-1930 c5c): no
    // task card yet, and a malformed card action is refused before the task host.
    await expect(client.request('mcp/presentation/subscribe', {})).resolves.toEqual({ tasks: [] });
    await expect(client.request('mcp/tasks/list', {})).resolves.toEqual({ tasks: [] });
    await expect(
      client.request('mcp/tasks/act', { action: 'explode', handle: {} } as never)
    ).rejects.toThrow();

    // A public-socket client reaches no desktop MCP status, control or presentations.
    cli = await hostClient(host, 'public-socket');
    await expect(cli.request('mcp/tasks/list', {})).rejects.toThrow(
      "MCP presentations are available only to the desktop's private client"
    );
    await expect(cli.request('mcp/status/read', {})).rejects.toThrow(
      "MCP settings are available only to the desktop's private client"
    );
    await expect(
      cli.request('mcp/server/control', { action: 'connect', configuredServerId })
    ).rejects.toThrow("MCP settings are available only to the desktop's private client");
  } finally {
    await cli?.close();
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await fixture.close();
    await rm(root, { force: true, recursive: true });
  }
});
