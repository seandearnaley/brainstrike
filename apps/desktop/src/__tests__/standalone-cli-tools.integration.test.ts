/**
 * M3 done-criterion 2: the standalone `brainstrike` CLI runs a native tool and
 * an MCP tool, and answers the MCP server's input request, on the same host
 * code path the desktop uses, with no Electron in any process.
 *
 * Real bin, temp data root, `--workspace` on a temp directory, the canonical
 * model-provider shim behind the provider base-URL knobs (no live calls), and
 * the real MCP Tasks reference server behind the pending-input relay.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  type PendingInputFixture,
  startPendingInputFixture,
} from '../../e2e/utils/mcp-pending-input-fixture';
import {
  type ModelProviderShim,
  resolveProviderEgressEnvironment,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim';

// The installed product bin: the package's own entry resolves its directory.
const require = createRequire(import.meta.url);
const bin = join(
  dirname(require.resolve('@brainstrike/host-capabilities')),
  '../bin/brainstrike.mjs'
);
const recordModuleLoads = pathToFileURL(
  join(import.meta.dirname, 'fixtures/record-module-loads.mjs')
).href;
const SERVER_ID = 'pending-input';
const MODEL = 'openai::gpt-6-sol';
const EDIT = { content: 'written by the standalone CLI\n', path: 'notes.txt' };
const FINAL = 'The note is written and the MCP task completed.';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

type Cli = (args: readonly string[]) => Promise<{ code: number; stderr: string; stdout: string }>;

function cli(dataRoot: string, environment: Record<string, string>): Cli {
  return (args) =>
    new Promise((resolve, reject) => {
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
            resolve({ code: 0, stderr, stdout });
          } else if (typeof cause.code === 'number') {
            resolve({ code: cause.code, stderr, stdout });
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

async function until(
  run: Cli,
  threadId: string,
  found: (rows: readonly HostLogRow[]) => boolean
): Promise<HostLogRow[]> {
  let latest: HostLogRow[] = [];
  await expect
    .poll(
      async () => {
        latest = await rows(run, threadId);
        return found(latest);
      },
      { timeout: 60_000 }
    )
    .toBe(true);
  return latest;
}

test('the standalone CLI runs a native write and an MCP task, answering its input, with no Electron', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-m3-cli-tools-data-'));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'bs-m3-cli-tools-ws-')));
  const moduleLog = join(dataRoot, 'module-loads.log');
  await writeFile(join(workspace, EDIT.path), 'original notes\n');
  // The model writes the note, then runs the MCP task. A tool the host does
  // not offer ends the turn with a reply naming the missing tool.
  const shim: ModelProviderShim = await startModelProviderShim((request) => {
    const write = request.toolNames.find((name) => name.endsWith('writeWorkspaceFile'));
    const task = request.toolNames.find((name) => name === `${SERVER_ID}_start_task`);
    if (!(write && task)) {
      return { finalText: `Tools not offered; offered: ${request.toolNames.join(', ')}` };
    }
    return {
      finalText: FINAL,
      toolCallStages: [[{ arguments: EDIT, name: write }], [{ arguments: {}, name: task }]],
    };
  });
  const server: PendingInputFixture = await startPendingInputFixture();
  const run = cli(dataRoot, {
    ...resolveProviderEgressEnvironment(shim, []),
    BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
    BRAINSTRIKE_TEST_MODULE_LOG: moduleLog,
    NODE_OPTIONS: `--import=${recordModuleLoads}`,
  });
  cleanup.push(async () => {
    await server.close();
    await shim.close();
    await rm(workspace, { force: true, recursive: true });
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
      servers: [
        { name: SERVER_ID, protocol: '2026-07-28', transport: 'streamable-http', url: server.url },
      ],
    })
  );

  // 1. A standalone host over the launch workspace, with the configured MCP server.
  expect(
    await run(['host', 'start', '--workspace', workspace, '--mcp-config', mcpConfig])
  ).toMatchObject({ code: 0, stderr: '' });

  // 2. The native write pauses for its approval, answered on the CLI.
  const paused = await run([
    'run',
    'Write the note, then run the MCP task.',
    '--model',
    MODEL,
    '--json',
    '--non-interactive',
  ]);
  // The run's model turn (not its title request) was offered both the shared
  // native tool and the configured MCP tool.
  expect(shim.requests().find((request) => request.toolNames.length > 0)?.toolNames).toEqual(
    expect.arrayContaining(['brainstrike_writeWorkspaceFile', `${SERVER_ID}_start_task`])
  );
  expect(paused.code, paused.stderr).toBe(2);
  const { runId, threadId } = z
    .object({ runId: z.string(), threadId: z.string() })
    .parse(JSON.parse(paused.stdout.split('\n')[0] ?? ''));
  const approval = (await rows(run, threadId)).find(
    (row) => row.event.type === 'interaction.requested'
  )?.event;
  if (approval?.type !== 'interaction.requested') {
    throw new Error('The native write did not pause for approval');
  }
  expect(approval).toMatchObject({ input: EDIT, toolId: 'brainstrike_writeWorkspaceFile' });
  expect(
    await run([
      'interaction',
      'respond',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interaction',
      approval.interactionId,
      '--decision',
      'approve',
    ])
  ).toMatchObject({ code: 0 });

  // 3. The MCP task asks for input; the CLI answers it.
  const asked = await until(run, threadId, (current) =>
    current.some((row) => row.event.type === 'mcp.input.requested')
  );
  const input = asked.find((row) => row.event.type === 'mcp.input.requested')?.event;
  if (input?.type !== 'mcp.input.requested') {
    throw new Error('The MCP task did not request input');
  }
  expect(
    await run([
      'mcp',
      'input',
      'settle',
      '--thread',
      threadId,
      '--run',
      runId,
      '--interaction',
      input.interactionId,
      '--action',
      'accept',
      '--content',
      JSON.stringify({ approved: true }),
    ])
  ).toMatchObject({ code: 0 });

  // 4. The committed log holds both tools' effects and the input exchange.
  const finished = await until(run, threadId, (current) =>
    current.some((row) => row.event.type === 'run.finished')
  );
  const events = finished.map((row) => row.event);
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
  const effects = (type: 'effect.started' | 'effect.finished') =>
    events.filter((event) => event.type === type);
  const started = effects('effect.started');
  expect(started.map((event) => ('toolId' in event ? event.toolId : undefined))).toEqual([
    'brainstrike_writeWorkspaceFile',
    expect.stringMatching(/start_task$/u),
  ]);
  expect(effects('effect.finished')).toHaveLength(2);
  expect(
    events
      .filter((event) => event.type.startsWith('mcp.input.'))
      .map((event) => ({
        type: event.type,
        ...('action' in event ? { action: event.action } : {}),
        ...('status' in event ? { status: event.status } : {}),
      }))
  ).toEqual([
    { type: 'mcp.input.requested' },
    { action: 'accept', type: 'mcp.input.intent' },
    { status: 'remote-acknowledged', type: 'mcp.input.settled' },
  ]);
  expect(await readFile(join(workspace, EDIT.path), 'utf8')).toBe(EDIT.content);
  expect(server.snapshot().requests.filter(({ method }) => method === 'tasks/update')).toHaveLength(
    1
  );
  expect(shim.refusals()).toEqual([]);

  // 5. Every CLI and host process ran the agent host's code, and none loaded Electron.
  const loads = (await readFile(moduleLog, 'utf8')).trim().split('\n');
  expect(loads.some((line) => line.includes('/agent-host/'))).toBe(true);
  expect(
    loads.filter((line) => /(?:^|\t|\/)electron(?:\/|$)|\/apps\/desktop\//u.test(line))
  ).toEqual([]);
});
