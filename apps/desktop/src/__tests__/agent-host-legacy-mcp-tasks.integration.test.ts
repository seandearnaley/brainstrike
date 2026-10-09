// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { type AgentHost, startAgentHost } from '@brainstrike/agent-host';
import {
  DEFAULT_PERMISSION_POLICIES,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { McpTaskRepository, migrate, readPgliteMcpTaskRows, wasmLoader } from '@brainstrike/db';
import { STATE_DB } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import {
  mainPlatformConnection,
  type PlatformMessagePort,
} from '../agent-host-platform/connection';
import { createHostPlatform } from '../agent-host-platform/desktop-node-platform';
import { serveDesktopPlatform } from '../agent-host-platform/main-platform';
import { installParentPlatformPort } from '../agent-host-platform/parent-platform-port';
import { createDesktopMcpPlatformCapabilities } from '../mcp/desktop-host-platform';
import { RemoteMcpRuntime } from '../mcp/remote-runtime';
import {
  owned,
  releaseOwned,
  startLab,
  TASKS_SERVER,
} from './fixtures/agent-host-mcp-modern-harness';
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

const LEGACY_PROMPT = 'legacy-desktop-task-input-fixture';
const configuredServerId = parseConfiguredMcpServerId(TASKS_SERVER);

/** The runtime holding the lab server's live Tasks authority: the host that opened its storage last. */
function labAuthorityRuntime(root: string): unknown {
  const db = new DatabaseSync(join(root, STATE_DB), { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT runtime_id FROM brainstrike_mcp_task_authorities WHERE server_id = ? AND retired_at IS NULL'
      )
      .get(TASKS_SERVER)?.['runtime_id'];
  } finally {
    db.close();
  }
}

function committed(root: string): { marker: unknown; tasks: unknown[] } {
  const db = new DatabaseSync(join(root, STATE_DB), { readOnly: true });
  try {
    const marker = db
      .prepare("SELECT value FROM settings WHERE key = 'mcp-tasks.legacy-import'")
      .get() as { value: string } | undefined;
    return {
      marker: marker === undefined ? undefined : JSON.parse(marker.value),
      tasks: db
        .prepare(
          'SELECT server_id, task_id, status, input_metadata, thread_id FROM brainstrike_mcp_tasks'
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

afterEach(releaseOwned);

/**
 * First launch after MCP Tasks moved into the host StateStore: the desktop's
 * PGlite still holds a pending task. The host's Tasks storage opens only after
 * it read those rows from Main over the platform connection and committed them;
 * later launches find the completion marker and never ask Main again.
 */
test("the host imports Main's PGlite Tasks rows once, before its Tasks storage opens", {
  timeout: 120_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-legacy-mcp-tasks-'));
  owned.push(() => rm(root, { force: true, recursive: true }));
  const pg = await wasmLoader.createPGlite('memory://legacy-mcp-tasks');
  owned.push(() => pg.close());
  await migrate(pg);
  const legacy = new McpTaskRepository(pg);
  const authority = await legacy.openAuthority({
    connectionGeneration: 4,
    principalId: 'linear:user-42',
    resource: 'https://mcp.linear.app/mcp',
    runtimeId: 'desktop-main-runtime',
    serverId: 'linear',
  });
  await legacy.create(
    {
      authorityEpoch: authority.authorityEpoch,
      inputMetadata: { prompt: LEGACY_PROMPT },
      principalId: authority.principalId,
      resource: authority.resource,
      serverId: authority.serverId,
      status: 'input_required',
      taskId: 'legacy-pending',
    },
    authority
  );
  const lab = await startLab('tasks-reference', context.signal);
  const mcpRuntime = new RemoteMcpRuntime();
  await writeDesktopMcpConfig(root, [
    {
      name: configuredServerId,
      protocol: '2026-07-28',
      startup: 'automatic',
      transport: 'streamable-http',
      url: lab.ready.endpoint,
    },
  ]);
  let legacyReads = 0;
  const capabilities = {
    ...createDesktopMcpPlatformCapabilities(mcpRuntime),
    readLegacyTasks: async () => {
      legacyReads += 1;
      return await readPgliteMcpTaskRows(pg);
    },
  };

  const launch = async (): Promise<AgentHost> => {
    const channel = new MessageChannel();
    const mainPort = new UtilityPort(channel.port1);
    const nodePort = new UtilityPort(channel.port2);
    const mainOwner = serveDesktopPlatform(mainPlatformConnection(mainPort), {
      mcp: capabilities,
      readConfiguration: async () => {
        throw new Error('This scenario admits no run');
      },
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
    });
    owned.push(async () => {
      await mainOwner.close();
      mainPort.close();
      nodePort.close();
    });
    expect(
      installParentPlatformPort({ data: { event: 'platform-capabilities' }, ports: [nodePort] })
    ).toBe(true);
    const options = { lifetime: 'persistent' as const, root };
    const host = await startAgentHost(options, (startup) =>
      createHostPlatform(options, startup, {
        appPaths: desktopAppPaths(root),
        credentialStore: { kind: 'file', path: join(root, 'credentials.json') },
      })
    );
    owned.push(() => host.close());
    return host;
  };

  const first = await launch();
  await expect.poll(() => mcpRuntime.host.snapshot().servers.length).toBe(1);
  const connected = await mcpRuntime.host.control({ action: 'connect', configuredServerId });
  expect(connected).toMatchObject({ extensions: { tasks: true }, state: 'connected' });
  await expect
    .poll(() => committed(root).marker, { timeout: 15_000 })
    .toEqual({
      at: expect.any(String),
      authorities: 1,
      tasks: 1,
    });
  expect(committed(root).tasks).toEqual([
    {
      input_metadata: JSON.stringify({ prompt: LEGACY_PROMPT }),
      server_id: 'linear',
      status: 'input_required',
      task_id: 'legacy-pending',
      thread_id: null,
    },
  ]);
  expect(legacyReads).toBe(1);
  const firstRuntime = labAuthorityRuntime(root);
  expect(firstRuntime).toEqual(expect.any(String));
  await first.close();

  await launch();
  await expect.poll(() => mcpRuntime.host.snapshot().servers.length).toBe(1);
  await mcpRuntime.host.control({ action: 'connect', configuredServerId });
  // The second host opened its Tasks storage (it rebound the lab's authority) without asking Main.
  await expect.poll(() => labAuthorityRuntime(root), { timeout: 15_000 }).not.toBe(firstRuntime);
  expect(legacyReads).toBe(1);
  expect(committed(root).tasks).toHaveLength(1);
});
