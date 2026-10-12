// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { type AgentHost, attachAgentHost, startAgentHost } from '@brainstrike/agent-host';
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

afterEach(() => vi.unstubAllGlobals());

/**
 * Signed legal gate, constraint 4: the openai-codex subscription is resolvable
 * only for an interactive desktop session. A CLI client attached to the
 * desktop's own host over its public socket is not one, even though the host
 * holds a live, refreshable sign-in for the desktop's profile.
 */
test('a CLI socket client attached to the desktop host cannot resolve the openai-codex subscription', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-subscription-origin-'));
  const channel = new MessageChannel();
  const mainPort = new UtilityPort(channel.port1);
  const nodePort = new UtilityPort(channel.port2);
  const requests: Request[] = [];
  // Every fetch is intercepted: no request leaves the process.
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ error: { type: 'fixture_terminal' } }, { status: 400 });
    })
  );
  // The desktop profile's private file store, holding a live sign-in the
  // host's engine would use for a desktop-origin run.
  const credentialStore = { kind: 'file' as const, path: join(root, 'credentials.json') };
  const seed = createHostCredentials({ selection: credentialStore });
  await seed.secrets().setCredential('openai-codex', {
    access: 'synthetic-offline-subscription-bearer',
    expires: Date.now() + 3_600_000,
    refresh: 'synthetic-offline-refresh',
    type: 'oauth',
  });
  await seed.close();
  const mainOwner = serveInProcessDesktopPlatform(mainPlatformConnection(mainPort), {
    admission: mainReads(),
    // Production's Main MCP stores; this scenario configures no MCP server.
    mcp: createDesktopMcpPlatformCapabilities(new MainMcpHostControl()),
  });
  let host: AgentHost | undefined;
  let client: Awaited<ReturnType<typeof attachAgentHost>> | undefined;
  try {
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    host = await startAgentHost(options, (context) =>
      createHostPlatform(options, context, { appPaths: desktopAppPaths(root), credentialStore })
    );
    // The CLI's transport: the host's public socket, authenticated by host.json.
    client = await attachAgentHost(host.record);
    const attached = client;
    const { threadId } = await attached.request('thread/start', { commandId: randomUUID() });
    const started = await attached
      .request('run/start', {
        commandId: randomUUID(),
        configuration: capturedIntent({
          agentLoop: { maxSteps: 1 },
          model: 'codex/gpt-5.5',
          provider: 'openai-codex',
        }),
        modelId: 'openai-codex::codex/gpt-5.5',
        prompt: 'Read README.md',
        threadId,
      })
      .then(
        () => 'admitted',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
    if (started === 'admitted') {
      // Join the admitted run before judging its egress and closing the host.
      await expect
        .poll(async () =>
          (await attached.request('thread/read', { fromSeq: 0, threadId })).rows.some(
            ({ event }) => event.type === 'run.finished'
          )
        )
        .toBe(true);
    }
    expect({ requests: requests.map(({ url }) => url), started }).toEqual({
      requests: [],
      started: expect.stringMatching(/interactive desktop/i),
    });
  } finally {
    await client?.close();
    await host?.close();
    await mainOwner.close();
    mainPort.close();
    nodePort.close();
    await rm(root, { force: true, recursive: true });
  }
});
