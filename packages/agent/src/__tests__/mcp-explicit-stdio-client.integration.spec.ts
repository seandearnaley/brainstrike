import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExplicitStdioMcpClient } from '../mcp/explicit-stdio-client';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/mcp-stdio-lifecycle-server.mjs', import.meta.url)
);
const FIXTURE_TOOL_NAMES = ['inspect_env', 'exit_once', 'invalid_output'];

interface FixtureState {
  exitToolCalls: number;
  starts: number;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0).reverse();
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Explicit stdio MCP test cleanup failed');
  }
});

async function createFixture(): Promise<{
  client: ExplicitStdioMcpClient;
  stateFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'brainstrike-mcp-stdio-'));
  cleanupTasks.push(() => rm(directory, { force: true, recursive: true }));
  const stateFile = join(directory, 'state.json');
  const client = new ExplicitStdioMcpClient({
    args: [FIXTURE_PATH],
    command: process.execPath,
    env: {
      BRAINSTRIKE_STDIO_TEST_OVERLAY: 'configured-overlay',
      BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
    },
    name: 'stdio-lifecycle-canary',
  });
  cleanupTasks.push(() => client.close());
  return { client, stateFile };
}

async function readStateFile(stateFile: string): Promise<FixtureState> {
  return JSON.parse(await readFile(stateFile, 'utf8')) as FixtureState;
}

describe('ExplicitStdioMcpClient integration', () => {
  it('connects lazily once for concurrent requests and overlays configured environment', async () => {
    const { client, stateFile } = await createFixture();

    await expect(stat(stateFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const [, firstTools, secondTools] = await Promise.all([
      client.connect(),
      client.listTools(),
      client.listTools(),
    ]);
    const environment = await client.callTool({ arguments: {}, name: 'inspect_env' });

    expect(firstTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    expect(secondTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    expect(environment.structuredContent).toEqual({
      configuredValue: 'configured-overlay',
      inheritedPathPresent: true,
    });
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 0,
      starts: 1,
    });
  });

  it('shares one terminal close operation and rejects later requests', async () => {
    const { client } = await createFixture();
    await client.connect();

    const firstClose = client.close();
    const secondClose = client.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(client.listTools()).rejects.toThrow('Explicit stdio MCP client is closed');
  });

  it('does not replay a disconnected tool call and reconnects only for the next operation', async () => {
    const { client, stateFile } = await createFixture();
    await client.connect();

    await expect(client.callTool({ arguments: {}, name: 'exit_once' })).rejects.toThrow(
      /connection closed/i
    );
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 1,
    });

    const reconnectedTools = await client.listTools();

    expect(reconnectedTools.tools.map((tool) => tool.name)).toEqual(FIXTURE_TOOL_NAMES);
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 2,
    });
  });

  it('restores SDK tool metadata before the first call on a reconnected child', async () => {
    const { client, stateFile } = await createFixture();
    await client.listTools();
    await expect(client.callTool({ arguments: {}, name: 'exit_once' })).rejects.toThrow(
      /connection closed/i
    );

    await expect(client.callTool({ arguments: {}, name: 'invalid_output' })).rejects.toThrow(
      /structured content does not match/i
    );
    await expect(readStateFile(stateFile)).resolves.toEqual({
      exitToolCalls: 1,
      starts: 2,
    });
  });
});
