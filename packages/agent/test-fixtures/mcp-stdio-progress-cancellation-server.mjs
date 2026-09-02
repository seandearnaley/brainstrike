// Explicit @brainstrike/agent test-fixture export; never used by production entrypoints.
//
// A progress-emitting stdio MCP server for BST-1594. `progress_forever` never
// answers on its own: it streams `notifications/progress` until the client
// cancels the request, which is exactly the shape that lets the SDK's
// `resetTimeoutOnProgress` defer its request timeout. The state file records
// how many progress notifications were sent and whether the server observed
// the client's `notifications/cancelled` (the SDK surfaces that as an abort on
// the handler's request signal), so a test can prove the cancellation actually
// reached the server rather than the request merely being abandoned.
import { rename, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const stateFile = process.env['BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE'];
if (!stateFile) {
  throw new Error('BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE is required');
}
const rawIntervalMs = process.env['BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS'];
const progressIntervalMs = rawIntervalMs === undefined ? 25 : Number(rawIntervalMs);
if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1) {
  throw new Error('BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS must be a positive safe integer');
}

const state = { cancelled: false, progressSent: 0 };

// Write-then-rename, never write-in-place: `writeFile` truncates before it
// writes, and the specs poll this file with `JSON.parse` while it is being
// rewritten every few milliseconds. A read landing inside the truncation window
// would see '' or half an object, and `expect.poll` would swallow the parse
// error — turning a real regression into an opaque timeout message instead of
// "cancelled never became true". `rename` is atomic on POSIX, so a reader sees
// either the previous state or the next one. The queue already serialises the
// writers; this closes the reader-side race.
const stateTempFile = `${stateFile}.tmp`;
let stateQueue = Promise.resolve();
function persistState() {
  stateQueue = stateQueue.then(async () => {
    await writeFile(stateTempFile, JSON.stringify(state), 'utf8');
    await rename(stateTempFile, stateFile);
  });
  return stateQueue;
}

await persistState();

const server = new Server(
  { name: 'brainstrike-desktop-stdio-progress-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      description: 'Emit progress notifications until the caller cancels the request.',
      inputSchema: { additionalProperties: false, type: 'object' },
      name: 'progress_forever',
    },
  ],
}));
server.setRequestHandler('tools/call', async (request, ctx) => {
  if (request.params.name !== 'progress_forever') {
    throw new Error(`Unknown fixture tool: ${String(request.params.name)}`);
  }
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) {
    throw new Error('The progress fixture requires a progressToken on the tools/call request');
  }
  return await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      state.progressSent += 1;
      ctx.mcpReq
        .notify({
          method: 'notifications/progress',
          params: { progress: state.progressSent, progressToken },
        })
        .then(persistState)
        .catch((error) => {
          clearInterval(timer);
          reject(error);
        });
    }, progressIntervalMs);
    ctx.mcpReq.signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer);
        state.cancelled = true;
        persistState().then(
          () => resolve({ content: [{ text: 'cancelled', type: 'text' }] }),
          reject
        );
      },
      { once: true }
    );
  });
});

await server.connect(new StdioServerTransport());
