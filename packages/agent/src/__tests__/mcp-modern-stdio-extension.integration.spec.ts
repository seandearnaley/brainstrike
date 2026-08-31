import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_ID,
  TEST_EXTENSION_REQUEST,
  TEST_EXTENSION_SETTINGS,
} from './fixtures/mcp-client-extension-registry';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-modern-extension-stdio-server.mjs', import.meta.url)
);
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const results = await Promise.allSettled(
    cleanupTasks
      .splice(0)
      .reverse()
      .map((task) => task())
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Pinned-modern stdio extension cleanup failed');
  }
});

it('sends a registered historical method on the exact spawned modern stdio wire', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-modern-extension-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const requestsFile = join(directory, 'requests.jsonl');
  const extension = createDeferredTestExtension();
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: { BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE: requestsFile },
    extensionRegistry: extension.registry,
    name: 'registered-modern-stdio-request-canary',
    protocol: '2026-07-28',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await expect(
    client.requestExtension(TEST_EXTENSION_REQUEST, { taskId: 'task-stdio-123' })
  ).resolves.toMatchObject({ status: 'working', taskId: 'task-stdio-123' });

  expect(extension.registerAnother).toThrow('sealed');

  const requests = (await readFile(requestsFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(requests.map((request) => request['method'])).toEqual(['server/discover', 'tasks/get']);
  expect(requests[0]).toMatchObject({
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
        },
      },
    },
  });
  expect(requests[1]).toMatchObject({
    method: 'tasks/get',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
        },
      },
      taskId: 'task-stdio-123',
    },
  });
  expect(JSON.stringify(requests)).not.toContain('io.brainstrike/registered-extension/');
});
