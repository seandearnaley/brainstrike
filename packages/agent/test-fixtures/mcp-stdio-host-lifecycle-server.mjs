// Explicit @brainstrike/agent test-fixture export; never used by production entrypoints.
import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const stateFile = process.env['BRAINSTRIKE_STDIO_TEST_STATE_FILE'];
if (!stateFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_STATE_FILE is required');
}
const pidFile = process.env['BRAINSTRIKE_STDIO_TEST_PID_FILE'];
if (!pidFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_PID_FILE is required');
}
const rawConnectDelayMs = process.env['BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS'];
const connectDelayMs = rawConnectDelayMs === undefined ? 0 : Number(rawConnectDelayMs);
if (!Number.isSafeInteger(connectDelayMs) || connectDelayMs < 0) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_CONNECT_DELAY_MS must be a non-negative safe integer');
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { listToolCalls: 0, starts: 0 };
    }
    throw error;
  }
}

let stateQueue = Promise.resolve();

function updateState(update) {
  stateQueue = stateQueue.then(async () => {
    const next = update(await readState());
    await writeFile(stateFile, JSON.stringify(next), 'utf8');
  });
  return stateQueue;
}

await updateState((state) => ({ ...state, starts: state.starts + 1 }));
await writeFile(pidFile, String(process.pid), 'utf8');

const server = new Server(
  { name: 'brainstrike-desktop-stdio-host-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
server.setRequestHandler('tools/list', async () => {
  await updateState((state) => ({ ...state, listToolCalls: state.listToolCalls + 1 }));
  return {
    tools: [
      {
        inputSchema: { additionalProperties: false, type: 'object' },
        name: 'host_lifecycle_probe',
      },
    ],
  };
});
if (connectDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
}
await server.connect(new StdioServerTransport());
