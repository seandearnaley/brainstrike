import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const stateFile = process.env['BRAINSTRIKE_STDIO_TEST_STATE_FILE'];
if (!stateFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_STATE_FILE is required');
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { exitToolCalls: 0, starts: 0 };
    }
    throw error;
  }
}

async function updateState(update) {
  const next = update(await readState());
  await writeFile(stateFile, JSON.stringify(next), 'utf8');
  return next;
}

await updateState((state) => ({ ...state, starts: state.starts + 1 }));

const server = new Server(
  {
    name: 'brainstrike-stdio-lifecycle-fixture',
    version: '1.0.0',
  },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      description: 'Expose the configured test environment and inherited PATH presence.',
      inputSchema: { additionalProperties: false, type: 'object' },
      name: 'inspect_env',
      outputSchema: {
        additionalProperties: false,
        properties: {
          configuredValue: { type: 'string' },
          inheritedPathPresent: { type: 'boolean' },
        },
        required: ['configuredValue', 'inheritedPathPresent'],
        type: 'object',
      },
    },
    {
      description: 'Exit the first child during a tool call, then answer if replayed.',
      inputSchema: { additionalProperties: false, type: 'object' },
      name: 'exit_once',
      outputSchema: {
        additionalProperties: false,
        properties: { replayed: { type: 'boolean' } },
        required: ['replayed'],
        type: 'object',
      },
    },
    {
      description: 'Return structured output that intentionally violates the advertised schema.',
      inputSchema: { additionalProperties: false, type: 'object' },
      name: 'invalid_output',
      outputSchema: {
        additionalProperties: false,
        properties: { count: { type: 'number' } },
        required: ['count'],
        type: 'object',
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'inspect_env') {
    const configuredValue = process.env['BRAINSTRIKE_STDIO_TEST_OVERLAY'];
    if (!configuredValue) {
      throw new Error('BRAINSTRIKE_STDIO_TEST_OVERLAY is required');
    }
    return {
      content: [{ text: 'environment inspected', type: 'text' }],
      structuredContent: {
        configuredValue,
        inheritedPathPresent: Boolean(process.env['PATH']),
      },
    };
  }

  if (request.params.name === 'exit_once') {
    const state = await updateState((current) => ({
      ...current,
      exitToolCalls: current.exitToolCalls + 1,
    }));
    if (state.exitToolCalls === 1) {
      setImmediate(() => process.exit(17));
      await new Promise(() => undefined);
    }
    return {
      content: [{ text: 'tool call was replayed', type: 'text' }],
      structuredContent: { replayed: true },
    };
  }

  if (request.params.name === 'invalid_output') {
    return {
      content: [{ text: 'invalid structured output', type: 'text' }],
      structuredContent: { count: 'not-a-number' },
    };
  }

  throw new Error(`Unknown lifecycle fixture tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
