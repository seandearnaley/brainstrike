// Explicit @brainstrike/agent test-fixture export; never used by production entrypoints.
//
// A modern-era (2026-07-28) stdio MCP server for BST-1600. It answers the
// host's requests normally until it has written N outbound messages, then
// SEVERS its own stdin (closing the read end of the parent's pipe) and exits
// after a delay.
//
// That is exactly what a child dying mid-handshake looks like from the host:
// the parent's next `stdin.write()` returns `false` and `'drain'` never fires,
// so the official SDK's `StdioClientTransport.send()` returns a promise that
// never settles — and the child's later exit fires `Client._onclose` while the
// caller is still suspended on that send. Severing and exiting are separate
// steps only so the window is deterministic; in production it is one event.
//
// The SDK negotiates modern stdio through a DISPOSABLE SIBLING child, so this
// entrypoint runs twice per connection: the probe child answers
// `server/discover`, the session child answers everything after it. Both apply
// the fault; the probe's copy is harmless because the SDK reaps that child as
// soon as the probe result is in.
import { closeSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function requiredPositiveInteger(name) {
  const raw = process.env[name];
  if (raw === undefined) {
    throw new Error(`${name} is required`);
  }
  const value = Number(raw);
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

const severAfterResponses = requiredPositiveInteger(
  'BRAINSTRIKE_STDIO_HANDSHAKE_SEVER_AFTER_RESPONSES'
);
const exitDelayMs = requiredPositiveInteger('BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_DELAY_MS');
const exitCode = requiredPositiveInteger('BRAINSTRIKE_STDIO_HANDSHAKE_EXIT_CODE');
const pidFile = process.env['BRAINSTRIKE_STDIO_HANDSHAKE_PID_FILE'];
if (!pidFile) {
  throw new Error('BRAINSTRIKE_STDIO_HANDSHAKE_PID_FILE is required');
}

function severStdin() {
  // Destroying the JS stream alone leaves file descriptor 0 open, so the
  // parent's pipe stays writable; the descriptor itself must be closed.
  process.stdin.pause();
  process.stdin.destroy();
  closeSync(0);
}

// The fault must land BETWEEN JSON-RPC messages, never inside one: a sever
// mid-frame would fail the spec on a truncated frame instead of on the
// assertion under test. `serializeMessage` terminates every frame with a
// newline, so only a chunk that ends in one completes a message.
function completesFrame(chunk) {
  if (typeof chunk === 'string') {
    return chunk.endsWith('\n');
  }
  if (ArrayBuffer.isView(chunk)) {
    return chunk.byteLength > 0 && chunk.at(-1) === 0x0a;
  }
  throw new Error(`Unsupported stdout chunk type: ${typeof chunk}`);
}

let responsesWritten = 0;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const result = write(chunk, ...rest);
  if (!completesFrame(chunk)) {
    return result;
  }
  responsesWritten += 1;
  if (responsesWritten === severAfterResponses) {
    // Arm the exit BEFORE severing. Severing is the step that could throw
    // (`closeSync` on a descriptor libuv may already own); doing it first would
    // lose the exit path and leave the child alive, which is not the scenario
    // the spec asserts.
    setTimeout(() => process.exit(exitCode), exitDelayMs);
    severStdin();
  }
  return result;
};

const echoSchema = z.strictObject({ text: z.string() });

function createServer() {
  const server = new McpServer({
    name: 'brainstrike-stdio-handshake-exit-fixture',
    version: '1.0.0',
  });
  server.registerTool(
    'handshake_probe',
    {
      description: 'Echo a string; present only so the connection advertises a tools catalog.',
      inputSchema: echoSchema,
      outputSchema: echoSchema,
    },
    async ({ text }) => ({ content: [{ text, type: 'text' }], structuredContent: { text } })
  );
  return server;
}

await writeFile(pidFile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
await serveStdio(createServer, { legacy: 'reject' });
