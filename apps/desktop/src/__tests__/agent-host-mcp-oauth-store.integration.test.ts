// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
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
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import {
  createMcpOAuthStoreIdentity,
  identityKey,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
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

const configuredServerId = parseConfiguredMcpServerId('fixture.oauth');
// Nothing listens here: this scenario reads stored credentials and never connects.
const SERVER_URL = 'http://127.0.0.1:9/mcp';
const ISSUER = 'https://auth.fixture.test';

/** The OAuth credential state Main mirrors for Settings from the host's runtime. */
function credentialState(runtime: RemoteMcpRuntime): string | undefined {
  const server = runtime.host
    .snapshot()
    .servers.find((candidate) => candidate.configuredServerId === configuredServerId);
  return server?.auth?.type === 'oauth-user' ? server.auth.credentialState : undefined;
}

/**
 * BST-1930 c4: the host owns its MCP OAuth records in the profile credential
 * store, under their 64-hex identity accounts, beside the provider keys. Its
 * runtime reads them there, and the host's factory reset clears them.
 */
test('the host reads its MCP OAuth records from the profile store and its reset clears them', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-mcp-oauth-store-'));
  const credentialsPath = join(root, 'credentials.json');
  const account = identityKey(createMcpOAuthStoreIdentity(configuredServerId, SERVER_URL));
  // A record exactly as the host's credential OAuth store writes it.
  const seeded = createHostCredentials({ selection: { kind: 'file', path: credentialsPath } });
  await seeded.store().write(
    account,
    JSON.stringify({
      [ISSUER]: { tokens: { access_token: 'fixture-access', token_type: 'Bearer' }, updatedAt: 1 },
    })
  );
  await seeded.close();
  const mcpRuntime = new RemoteMcpRuntime();
  await mcpRuntime.replaceResolvedConfig({
    servers: [
      {
        auth: { type: 'oauth-user' },
        name: configuredServerId,
        protocol: '2026-07-28',
        startup: 'authentication-required',
        transport: 'streamable-http',
        url: SERVER_URL,
      },
    ],
  });
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
    mcp: createDesktopMcpPlatformCapabilities(mcpRuntime),
    readConfiguration: async () => {
      throw new Error('This scenario admits no run');
    },
    // Gap 17's import capability; this scenario reads no legacy memory.
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
        credentialStore: { kind: 'file', path: credentialsPath },
      })
    );
    desktop = await desktopClient(host);
    // Settings' status, mirrored from the host's first configuration, names the stored grant.
    await expect.poll(() => credentialState(mcpRuntime), { timeout: 15_000 }).toBe('stored');

    await desktop.request('auth/clear', {});
    const file: unknown = JSON.parse(await readFile(credentialsPath, 'utf8'));
    expect(file).toEqual({ records: {}, secrets: {}, version: 1 });
  } finally {
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  }
});
