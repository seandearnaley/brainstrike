import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const requestsFile = process.env['BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE'];
if (!requestsFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE is required');
}

const extensionId = 'com.example/integration-host';
const extensionSettings = { mode: 'strict' };
const serverInfo = { name: 'brainstrike-modern-extension-fixture', version: '1.0.0' };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) {
    continue;
  }
  const request = JSON.parse(line);
  await appendFile(requestsFile, `${JSON.stringify(request)}\n`, 'utf8');
  if (request.method === 'server/discover') {
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        cacheScope: 'private',
        capabilities: { extensions: { [extensionId]: extensionSettings } },
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        ttlMs: 0,
      },
    });
    continue;
  }
  if (request.method === 'tasks/get') {
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        resultType: 'complete',
        status: 'working',
        taskId: request.params?.taskId,
      },
    });
    continue;
  }
  if (request.id === undefined) {
    continue;
  }
  send({
    error: { code: -32_601, message: `Method not found: ${String(request.method)}` },
    id: request.id,
    jsonrpc: '2.0',
  });
}
