import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const stateFile = process.env['BRAINSTRIKE_STDIO_TEST_STATE_FILE'];
if (!stateFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_STATE_FILE is required');
}
const capabilitiesFile = process.env['BRAINSTRIKE_STDIO_TEST_CAPABILITIES_FILE'];
if (!capabilitiesFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_CAPABILITIES_FILE is required');
}
const pidFile = process.env['BRAINSTRIKE_STDIO_TEST_PID_FILE'];
if (!pidFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_PID_FILE is required');
}
const rawConnectDelayMs = process.env['BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS'];
const startupDiagnostic = process.env['BRAINSTRIKE_STDIO_TEST_STDERR'];
const connectDelayMs = rawConnectDelayMs === undefined ? 0 : Number(rawConnectDelayMs);
const paginateTools = process.env['BRAINSTRIKE_STDIO_TEST_PAGINATE_TOOLS'] === '1';
const removeInvalidOutputAfterRestart =
  process.env['BRAINSTRIKE_STDIO_TEST_REMOVE_INVALID_OUTPUT_AFTER_RESTART'] === '1';
if (!Number.isSafeInteger(connectDelayMs) || connectDelayMs < 0) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS must be a non-negative safe integer');
}
if (startupDiagnostic) {
  console.error(startupDiagnostic);
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { exitToolCalls: 0, listToolCalls: 0, starts: 0 };
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
await writeFile(pidFile, String(process.pid), 'utf8');

const server = new Server(
  {
    name: 'brainstrike-stdio-lifecycle-fixture',
    version: '1.0.0',
  },
  { capabilities: { prompts: {}, resources: {}, tools: {} } }
);

server.setRequestHandler('prompts/list', async () => {
  const state = await updateState((current) => ({
    ...current,
    listPromptCalls: (current.listPromptCalls ?? 0) + 1,
  }));
  return { prompts: [{ name: `prompt-${state.starts}` }] };
});

server.setRequestHandler('resources/list', async () => {
  const state = await updateState((current) => ({
    ...current,
    listResourceCalls: (current.listResourceCalls ?? 0) + 1,
  }));
  return {
    resources: [{ name: `resource-${state.starts}`, uri: `file:///resource-${state.starts}` }],
  };
});

server.setRequestHandler('resources/templates/list', async () => {
  const state = await updateState((current) => ({
    ...current,
    listResourceTemplateCalls: (current.listResourceTemplateCalls ?? 0) + 1,
  }));
  return {
    resourceTemplates: [
      { name: `template-${state.starts}`, uriTemplate: `file:///template-${state.starts}/{id}` },
    ],
  };
});

server.setRequestHandler('tools/list', async (request) => {
  const state = await updateState((state) => ({
    ...state,
    listToolCalls: (state.listToolCalls ?? 0) + 1,
    ...(paginateTools
      ? {
          listTraceIds: [...(state.listTraceIds ?? []), request.params?._meta?.traceId ?? null],
        }
      : {}),
  }));
  const tools = [
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
  ].filter(
    (tool) =>
      !(removeInvalidOutputAfterRestart && state.starts > 1 && tool.name === 'invalid_output')
  );
  if (!paginateTools) {
    return { tools };
  }
  if (request.params?.cursor === undefined) {
    return { nextCursor: 'page-2', tools: tools.slice(0, 2) };
  }
  if (request.params.cursor === 'page-2') {
    return { tools: tools.slice(2) };
  }
  throw new Error(`Unknown lifecycle fixture cursor: ${request.params.cursor}`);
});

server.setRequestHandler('tools/call', async (request) => {
  await writeFile(capabilitiesFile, JSON.stringify(server.getClientCapabilities() ?? null), 'utf8');
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

if (connectDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
}
await server.connect(new StdioServerTransport());
