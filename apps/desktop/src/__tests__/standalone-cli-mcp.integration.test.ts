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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '@brainstrike/agent-host/protocol';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock } from '@brainstrike/state-store';
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
    id: 'modern-reference',
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

test('a standalone host composes --mcp-config servers and runs their tools', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'bs-c2-cli-mcp-'));
  const server = await lab.startMcpLabScenario('modern-reference', { execution: 'loopback' });
  if (server.endpoint.kind !== 'loopback-http') {
    throw new Error('The modern reference scenario has no loopback HTTP endpoint');
  }
  // The model calls the configured MCP tool, then answers. A turn without the
  // tool (the title request) ends with a reply naming what was offered.
  const shim: ModelProviderShim = await startModelProviderShim((request) =>
    request.toolNames.includes(TOOL)
      ? { finalText: FINAL, toolCall: { arguments: {}, name: TOOL } }
      : { finalText: `No ${TOOL} offered: ${request.toolNames.join(', ')}` }
  );
  const run = cli(dataRoot, {
    ...resolveProviderEgressEnvironment(shim, []),
    BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture',
  });
  cleanup.push(async () => {
    await server.close();
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
      servers: [
        {
          name: SERVER,
          protocol: '2026-07-28',
          transport: 'streamable-http',
          url: server.endpoint.url.href,
        },
      ],
    })
  );

  expect(await run(['host', 'start', '--mcp-config', mcpConfig])).toMatchObject({
    code: 0,
    stderr: '',
  });
  // An attached host keeps the MCP configuration it started with.
  const attached = await run(['host', 'start', '--mcp-config', mcpConfig]);
  expect(attached.code).toBe(1);
  expect(attached.stderr).toContain('--mcp-config requires a new host');

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
  expect(events.find((event) => event.type === 'run.started')).toMatchObject({
    runId,
    snapshot: {
      configuration: { capabilities: { configuredMcp: 'available', tasks: 'unavailable' } },
    },
  });
  expect(events.find((event) => event.type === 'effect.started')).toMatchObject({
    toolCatalogId: `${SERVER}.test_simple_text`,
    toolId: TOOL,
  });
  const effect = events.find((event) => event.type === 'effect.finished');
  expect(JSON.stringify(effect)).toContain('This is a simple text response for testing.');
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
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
