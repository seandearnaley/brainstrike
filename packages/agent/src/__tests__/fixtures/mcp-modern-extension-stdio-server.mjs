import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const requestsFile = process.env['BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE'];
if (!requestsFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_REQUESTS_FILE is required');
}

/**
 * Which requested task ids the fixture acknowledges on `subscriptions/listen`:
 * `full` (default) echoes them, `partial` honors only the first, `empty` sends
 * an acknowledgement with no task ids at all.
 */
const ackMode = process.env['BRAINSTRIKE_STDIO_TEST_ACK_MODE'] ?? 'full';
if (!['full', 'partial', 'empty'].includes(ackMode)) {
  throw new Error(`Unsupported BRAINSTRIKE_STDIO_TEST_ACK_MODE: ${ackMode}`);
}

function acknowledgedNotifications(requested) {
  if (ackMode === 'empty') {
    return {};
  }
  const taskIds = requested ?? [];
  return { taskIds: ackMode === 'partial' ? taskIds.slice(0, 1) : taskIds };
}

const extensionId = 'io.modelcontextprotocol/tasks';
const extensionSettings = {};
const serverInfo = { name: 'brainstrike-modern-extension-fixture', version: '1.0.0' };
const task = {
  createdAt: '2026-08-31T20:00:00Z',
  lastUpdatedAt: '2026-08-31T20:00:01Z',
  status: 'working',
  taskId: 'task-stdio-123',
  ttlMs: null,
};

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
        capabilities: { extensions: { [extensionId]: extensionSettings }, tools: {} },
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
        ...task,
        taskId: request.params?.taskId,
      },
    });
    continue;
  }
  if (request.method === 'tasks/update' || request.method === 'tasks/cancel') {
    send({ id: request.id, jsonrpc: '2.0', result: { resultType: 'complete' } });
    continue;
  }
  if (request.method === 'tools/list') {
    send({
      id: request.id,
      jsonrpc: '2.0',
      result: {
        cacheScope: 'private',
        resultType: 'complete',
        tools: [
          {
            description: 'Complete immediately',
            inputSchema: { additionalProperties: false, type: 'object' },
            name: 'sync-tool',
          },
          {
            description: 'Defer the call to a task',
            inputSchema: { additionalProperties: false, type: 'object' },
            name: 'deferred-tool',
          },
        ],
        ttlMs: 0,
      },
    });
    continue;
  }
  if (request.method === 'tools/call') {
    send({
      id: request.id,
      jsonrpc: '2.0',
      result:
        request.params?.name === 'sync-tool'
          ? { content: [], resultType: 'complete' }
          : { ...task, resultType: 'task' },
    });
    continue;
  }
  if (request.method === 'subscriptions/listen') {
    const subscriptionId = request.id;
    send({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId },
        notifications: acknowledgedNotifications(request.params?.notifications?.taskIds),
      },
    });
    if (ackMode !== 'full') {
      continue;
    }
    send({
      jsonrpc: '2.0',
      method: 'notifications/tasks',
      params: {
        _meta: { 'io.modelcontextprotocol/subscriptionId': subscriptionId },
        ...task,
        lastUpdatedAt: '2026-08-31T20:00:02Z',
        result: { content: [], isError: false },
        status: 'completed',
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
