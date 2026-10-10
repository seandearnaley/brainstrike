// @vitest-environment node
import { randomUUID } from 'node:crypto';
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
import { createHostCredentials } from '@brainstrike/host-capabilities/credentials';
import { afterEach, expect, test, vi } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createHostPlatform } from '../agent-host-platform-entry';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { MainMcpHostControl } from '../mcp/main-host-control';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';
import { desktopAppPaths } from './fixtures/desktop-host-profile';
import { serveInProcessDesktopPlatform } from './fixtures/in-process-desktop-platform';

/** The shipped Codex endpoints (descriptors/openai-codex), matched as recorded. */
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

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

afterEach(() => vi.unstubAllGlobals());

/**
 * The host's engine is the profile's only refresher. A desktop-ui run and the
 * legacy server's verification (Main's private client) share one refresh of a
 * rotating token: the expired refresh token is presented once and never
 * replayed, and the rotated pair is what the host persists. Factory reset then
 * drops the refreshed sign-in the host holds.
 */
test('a desktop run and the legacy verifier share the host refresher without replay, and reset drops it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-subscription-refresher-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const tokenRequests: URLSearchParams[] = [];
  const responsesRequests: Request[] = [];
  const secondRefresh = Promise.withResolvers<void>();
  const refreshHeld = Promise.withResolvers<void>();
  // Every fetch is intercepted: no request leaves the process.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === CODEX_TOKEN_URL) {
        tokenRequests.push(new URLSearchParams(await request.text()));
        if (tokenRequests.length > 1) {
          secondRefresh.resolve();
        }
        await refreshHeld.promise;
        return Response.json({
          access_token: 'refreshed-access-1',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-2',
          token_type: 'Bearer',
        });
      }
      if (request.url === CODEX_RESPONSES_ENDPOINT) {
        responsesRequests.push(request);
        return Response.json({ error: { type: 'fixture_terminal' } }, { status: 400 });
      }
      throw new Error(`Unexpected egress to ${request.url}`);
    })
  );
  const credentialFile = join(root, 'credentials.json');
  const credentialStore = { kind: 'file' as const, path: credentialFile };
  const seed = createHostCredentials({ selection: credentialStore });
  await seed.secrets().setCredential('openai-codex', {
    access: 'stored-access-0',
    accountId: 'synthetic-account',
    expires: Date.now() - 60_000,
    refresh: 'stored-refresh-1',
    type: 'oauth',
  });
  await seed.close();
  const mainOwner = serveInProcessDesktopPlatform(mainPlatformConnection(mainPort), {
    admission: mainReads(),
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  let host: AgentHost | undefined;
  let desktop: HostClient | undefined;
  let socket: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, { appPaths: desktopAppPaths(root), credentialStore })
    );
    desktop = await desktopClient(host);
    const ui = desktop;
    const { threadId } = await ui.request('thread/start', { commandId: randomUUID() });
    await ui.request('run/start', {
      commandId: randomUUID(),
      configuration: capturedIntent({
        agentLoop: { maxSteps: 1 },
        model: 'codex/gpt-5.5',
        provider: 'openai-codex',
      }),
      modelId: 'openai-codex::codex/gpt-5.5',
      prompt: 'Read README.md',
      threadId,
    });
    // The run's subscription fetch is refreshing the expired pair, held open.
    await expect.poll(() => tokenRequests.length).toBe(1);
    // The legacy server's verification arrives through Main's private client.
    const verified = ui.request('auth/verify', { provider: 'openai-codex' });
    // A second refresher would present the same refresh token now.
    await Promise.race([
      secondRefresh.promise,
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    refreshHeld.resolve();
    await expect(verified).resolves.toEqual({ ok: true });
    await expect
      .poll(async () =>
        (await ui.request('thread/read', { fromSeq: 0, threadId })).rows.some(
          ({ event }) => event.type === 'run.finished'
        )
      )
      .toBe(true);

    expect(tokenRequests.map((body) => body.get('refresh_token'))).toEqual(['stored-refresh-1']);
    // The run's model call and its thread-title call both use the refreshed token.
    expect(responsesRequests.length).toBeGreaterThan(0);
    expect(new Set(responsesRequests.map(({ headers }) => headers.get('authorization')))).toEqual(
      new Set(['Bearer refreshed-access-1'])
    );
    const stored = await readFile(credentialFile, 'utf8');
    expect(stored).toContain('rotated-refresh-2');
    expect(stored).not.toContain('stored-refresh-1');

    // A CLI client on the public socket can neither verify nor reset.
    socket = await attachAgentHost(host.record);
    await expect(socket.request('auth/verify', { provider: 'openai-codex' })).rejects.toThrow(
      "desktop's private client"
    );
    await expect(socket.request('auth/clear', {})).rejects.toThrow("desktop's private client");

    // Factory reset through the desktop client drops the refreshed sign-in.
    await expect(ui.request('auth/clear', {})).resolves.toEqual({ cleared: true });
    await expect(ui.request('auth/status', { provider: 'openai-codex' })).resolves.toEqual({
      state: 'disconnected',
    });
    await expect(ui.request('auth/verify', { provider: 'openai-codex' })).resolves.toEqual({
      ok: false,
      status: 'not_connected',
    });
    expect(await readFile(credentialFile, 'utf8')).not.toContain('refresh');
    expect(tokenRequests).toHaveLength(1);
  } finally {
    refreshHeld.resolve();
    await socket?.close();
    await desktop?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  }
});
