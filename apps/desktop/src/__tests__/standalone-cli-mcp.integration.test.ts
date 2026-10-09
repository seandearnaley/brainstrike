/**
 * Stage c2: a standalone host composes the configured MCP servers from
 * `--mcp-config` and runs their tools on the same host code path the desktop
 * uses. Real bin, temp data root, the canonical model-provider shim behind the
 * provider base-URL knobs (no live calls), and the MCP lab's modern reference
 * server on loopback.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, STATE_DB } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import type { McpLabSession } from '../../../../packages/mcp-test-lab/dist/index.js';
import {
  type ModelProviderShim,
  resolveProviderEgressEnvironment,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

const require = createRequire(import.meta.url);
const bin = join(
  dirname(require.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);
const lab: {
  startMcpLabScenario(
    id: 'legacy-reference' | 'modern-reference' | 'tasks-reference',
    options: { readonly execution: 'loopback' }
  ): Promise<McpLabSession>;
} = await import(
  pathToFileURL(resolve(import.meta.dirname, '../../../../packages/mcp-test-lab/dist/index.js'))
    .href
);
const SERVER = 'reference';
const TOOL = `${SERVER}_test_simple_text`;
const MODEL = 'openai::gpt-6-sol';
const FINAL = 'The reference server answered.';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Cli = (args: readonly string[]) => Promise<{ code: number; stderr: string; stdout: string }>;

function cli(dataRoot: string, environment: Record<string, string>): Cli {
  return (args) =>
    new Promise((resolveRun, reject) => {
      execFile(
        process.execPath,
        [bin, '--data-root', dataRoot, ...args],
        {
          cwd: tmpdir(),
          env: {
            ...environment,
            LC_ALL: 'C',
            PATH: process.env['PATH'],
            SystemRoot: process.env['SystemRoot'],
            TZ: 'UTC',
          },
          timeout: 30_000,
          windowsHide: true,
        },
        (cause, stdout, stderr) => {
          if (!cause) {
            resolveRun({ code: 0, stderr, stdout });
          } else if (typeof cause.code === 'number') {
            resolveRun({ code: cause.code, stderr, stdout });
          } else {
            reject(cause);
          }
        }
      );
    });
}

async function rows(run: Cli, threadId: string): Promise<HostLogRow[]> {
  const shown = await run(['threads', 'show', '--thread', threadId]);
  expect(shown).toMatchObject({ code: 0, stderr: '' });
  return HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout)).rows;
}

async function labUrl(
  id: 'legacy-reference' | 'modern-reference' | 'tasks-reference'
): Promise<string> {
  const session = await lab.startMcpLabScenario(id, { execution: 'loopback' });
  cleanup.push(async () => {
    await session.close();
  });
  if (session.endpoint.kind !== 'loopback-http') {
    throw new Error(`The ${id} scenario has no loopback HTTP endpoint`);
  }
  return session.endpoint.url.href;
}

/** A loopback port nothing listens on: every connection is refused. */
async function refusedUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((listening) => probe.listen(0, '127.0.0.1', listening));
  const address = probe.address();
  await new Promise<void>((closed) => probe.close(() => closed()));
  if (!address || typeof address === 'string') {
    throw new Error('The loopback probe has no port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

/** A started standalone host over `servers`, whose model calls `tool` once. */
async function startHost(servers: readonly Record<string, string>[], tool = TOOL) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-c2-cli-mcp-'));
  // Hosted discovery defers MCP tools: the model loads the configured MCP tool,
  // calls it, then answers. A turn without discovery (the title request) ends
  // with a reply naming what was offered.
  const shim: ModelProviderShim = await startModelProviderShim((request) =>
    request.toolNames.includes('load_tool')
      ? { deferredTool: true, finalText: FINAL, toolCall: { arguments: {}, name: tool } }
      : { finalText: `No load_tool offered: ${request.toolNames.join(', ')}` }
  );
  const run = cli(dataRoot, {
    ...resolveProviderEgressEnvironment(shim, []),
    BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
  });
  cleanup.push(async () => {
    await shim.close();
    await rm(dataRoot, { force: true, recursive: true });
  });
  cleanup.push(async () => {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      const { pid } = decodeHostRecord(
        JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8'))
      );
      expect(await run(['host', 'stop'])).toMatchObject({ code: 0 });
      await expect.poll(() => processStartTime(pid)).toBeNull();
    }
  });
  const mcpConfig = join(dataRoot, 'mcp.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({
      servers: servers.map((server) => ({
        protocol: '2026-07-28',
        transport: 'streamable-http',
        ...server,
      })),
    })
  );
  expect(await run(['host', 'start', '--mcp-config', mcpConfig])).toMatchObject({
    code: 0,
    stderr: '',
  });
  return { dataRoot, mcpConfig, run, shim };
}

/** One completed `run --json` over the reference tool; its committed events. */
async function runReferenceTool(run: Cli) {
  const finished = await run([
    'run',
    'Call the reference server.',
    '--model',
    MODEL,
    '--json',
    '--non-interactive',
  ]);
  expect(finished.code, finished.stderr).toBe(0);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(finished.stdout.split('\n')[0] ?? ''));
  const events = (await rows(run, threadId)).map((row) => row.event);
  const started = events.find((event) => event.type === 'effect.started' && event.toolId === TOOL);
  expect(started).toMatchObject({ toolCatalogId: `${SERVER}.test_simple_text`, toolId: TOOL });
  const effect = events.find(
    (event) =>
      event.type === 'effect.finished' &&
      started?.type === 'effect.started' &&
      event.toolCallId === started.toolCallId
  );
  expect(JSON.stringify(effect)).toContain('This is a simple text response for testing.');
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
  return { events, runId, threadId };
}

test('a standalone host composes --mcp-config servers and runs their tools', async () => {
  const { mcpConfig, run, shim } = await startHost([
    { name: SERVER, url: await labUrl('modern-reference') },
  ]);
  // An attached host keeps the MCP configuration it started with.
  const attached = await run(['host', 'start', '--mcp-config', mcpConfig]);
  expect(attached.code).toBe(1);
  expect(attached.stderr).toContain('--mcp-config requires a new host');

  const { events, runId, threadId } = await runReferenceTool(run);
  expect(events.find((event) => event.type === 'run.started')).toMatchObject({
    runId,
    snapshot: {
      configuration: { capabilities: { configuredMcp: 'available', tasks: 'available' } },
    },
  });
  expect(events.some((event) => event.type === 'mcp.tools.unavailable')).toBe(false);
  expect(shim.refusals()).toEqual([]);

  // `mcp input settle` refuses content on anything but an accept before reaching the host.
  const refused = await run([
    'mcp',
    'input',
    'settle',
    '--thread',
    threadId,
    '--run',
    runId,
    '--interaction',
    'not-requested',
    '--action',
    'decline',
    '--content',
    '{}',
  ]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('--content applies only to --action accept');
});

test('a run skips each unavailable MCP server visibly and keeps the reachable ones', async () => {
  const { run, shim } = await startHost([
    { name: SERVER, url: await labUrl('modern-reference') },
    { name: 'down', url: await refusedUrl() },
    // A legacy-era server configured as modern: its protocol does not match.
    { name: 'mismatched', url: await labUrl('legacy-reference') },
  ]);

  const { events, runId, threadId } = await runReferenceTool(run);
  const unavailable = events.filter((event) => event.type === 'mcp.tools.unavailable');
  expect(
    unavailable.map((event) => ('serverId' in event ? event.serverId : undefined)).sort()
  ).toEqual(['down', 'mismatched']);
  for (const event of unavailable) {
    expect(event).toMatchObject({ reason: expect.any(String), runId });
  }
  expect(shim.refusals()).toEqual([]);

  // The CLI names each skipped server when it shows the run.
  const shown = await run(['attach', '--thread', threadId, '--run', runId, '--non-interactive']);
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.stderr).toContain('MCP server down unavailable:');
  expect(shown.stderr).toContain('MCP server mismatched unavailable:');
});

// Eight CLI processes and one host: each process start costs seconds on a loaded machine.
test('a standalone host runs an MCP Task to its input, and the CLI settles it', {
  timeout: 60_000,
}, async () => {
  const tasksServer = 'tasks';
  const { dataRoot, run, shim } = await startHost(
    [{ name: tasksServer, url: await labUrl('tasks-reference') }],
    `${tasksServer}_start_task`
  );

  // A non-interactive run stops at the committed input and names how to answer it.
  const started = await run([
    'run',
    'Start the reference task.',
    '--model',
    MODEL,
    '--json',
    '--non-interactive',
  ]);
  expect(started.code, started.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(started.stdout.split('\n')[0] ?? ''));
  const requested = (await rows(run, threadId))
    .map((row) => row.event)
    .find((event) => event.type === 'mcp.input.requested');
  expect(requested).toMatchObject({
    configuredServerId: tasksServer,
    mode: 'form',
    runId,
    taskId: expect.any(String),
  });
  const interactionId = requested && 'interactionId' in requested ? requested.interactionId : '';
  const address = ['--thread', threadId, '--run', runId, '--interaction', interactionId];
  expect(started.stderr).toContain(`mcp input settle ${address.join(' ')}`);

  const read = await run(['mcp', 'input', 'read', ...address]);
  expect(read.code, read.stderr).toBe(0);
  expect(HOST_RESULT_SCHEMAS['mcp/input/read'].parse(JSON.parse(read.stdout))).toMatchObject({
    presentation: { message: 'Approve the reference task?', mode: 'form' },
    status: 'requested',
  });
  const settled = await run([
    'mcp',
    'input',
    'settle',
    ...address,
    '--action',
    'accept',
    '--content',
    JSON.stringify({ approved: true }),
  ]);
  expect(settled.code, settled.stderr).toBe(0);

  const finished = await run([
    'attach',
    '--thread',
    threadId,
    '--run',
    runId,
    '--non-interactive',
    '--json',
  ]);
  expect(finished.code, finished.stderr).toBe(0);
  const events = (await rows(run, threadId)).map((row) => row.event);
  expect(events.find((event) => event.type === 'run.started')).toMatchObject({
    snapshot: { configuration: { capabilities: { tasks: 'available' } } },
  });
  expect(events.find((event) => event.type === 'mcp.input.settled')).toMatchObject({
    interactionId,
    status: 'remote-acknowledged',
  });
  const task = events.find(
    (event) => event.type === 'effect.started' && event.toolId === `${tasksServer}_start_task`
  );
  expect(
    events.find(
      (event) =>
        event.type === 'effect.finished' &&
        task?.type === 'effect.started' &&
        event.toolCallId === task.toolCallId
    )
  ).toMatchObject({
    output: { kind: 'mcp-task', task: { recovery: 'terminal', status: 'completed' } },
  });
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
  expect(shim.refusals()).toEqual([]);

  // The task row lives in the host's StateStore, bound to the thread whose run created it.
  const db = new DatabaseSync(join(dataRoot, STATE_DB), { readOnly: true });
  try {
    expect(
      db.prepare('SELECT server_id, status, thread_id FROM brainstrike_mcp_tasks').all()
    ).toEqual([{ server_id: tasksServer, status: 'completed', thread_id: threadId }]);
  } finally {
    db.close();
  }
});
