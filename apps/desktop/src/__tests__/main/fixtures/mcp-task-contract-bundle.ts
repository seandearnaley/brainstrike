import assert from 'node:assert/strict';
import * as clientModule from '@brainstrike/agent/mcp-client';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import type { McpTaskElicitationBinding } from '../../../mcp/elicitation-presenter';
import * as taskModule from '../../../mcp/task-host';

// Run in plain Node: Vitest source aliases conceal public-bundle identities.
const db = await wasmLoader.createPGlite('memory://bst1948-built-contract');
let host: taskModule.McpDesktopTaskHost | undefined;
try {
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  const registry = new clientModule.McpClientExtensionRegistry();
  clientModule.registerMcpTasksWireContracts(registry);
  const serverId = parseConfiguredMcpServerId('task-contract-fixture');
  const methods: string[] = [];
  const failures: unknown[] = [];
  let status: 'working' | 'input_required' | 'cancelled' = 'working';
  let inputSignal: AbortSignal | undefined;
  const presented = Promise.withResolvers<void>();
  void presented.promise.catch(() => undefined);
  host = new taskModule.McpDesktopTaskHost({
    elicitationPresenter: {
      bindTaskPresenter: (binding: McpTaskElicitationBinding) => {
        assert.equal(binding.taskHandle.taskId, 'task-1');
        return {
          presenter: {
            confirmUrl: async () => ({ action: 'cancel' as const }),
            form: true,
            openExternal: async () => undefined,
            presentForm: async (_request, context) => {
              inputSignal = context.signal;
              presented.resolve();
              return await new Promise<never>(() => undefined);
            },
            url: true,
          },
          release: () => undefined,
        };
      },
    },
    lifecycleLimits: {
      initialPollMs: 10,
      maxBackoffMs: 20,
      maxConcurrentPolls: 1,
      maxLifetimeMs: 60_000,
      maxTransportFailures: 1,
      minimumPollMs: 5,
      pollRequestTimeoutMs: 1000,
    },
    onInternalError: (code, error) => {
      failures.push(error);
      if (code !== 'mcp-task-notification-lease-unavailable') {
        presented.reject(error);
      }
    },
    openDatabase: async () => db,
    runtimeId: 'built-contract-fixture',
  });
  const createdAt = '2026-10-03T00:00:00.000Z';
  const capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
  await host.connected({
    client: {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getServerCapabilities: () => capabilities,
      listenTasks: async (taskIds) => ({
        close: async () => undefined,
        closed: new Promise<never>(() => undefined),
        honoredTaskIds: taskIds,
      }),
      requestExtension: async (contract, params) => {
        await registry.prepareRequest(contract, params, capabilities.extensions, '2026-07-28');
        methods.push(contract.method);
        let result: unknown;
        if (contract.method === 'tasks/cancel') {
          assert.equal(inputSignal?.aborted, true);
          status = 'cancelled';
          result = { resultType: 'complete' };
        } else if (contract.method === 'tasks/get') {
          result = {
            createdAt,
            lastUpdatedAt:
              status === 'cancelled' ? '2026-10-03T00:00:02.000Z' : '2026-10-03T00:00:01.000Z',
            pollIntervalMs: 10,
            resultType: 'complete',
            status,
            taskId: 'task-1',
            ttlMs: 60_000,
            ...(status === 'input_required'
              ? {
                  inputRequests: {
                    approval: {
                      method: 'elicitation/create',
                      params: {
                        message: 'Approve?',
                        mode: 'form',
                        requestedSchema: {
                          properties: { approved: { type: 'boolean' } },
                          required: ['approved'],
                          type: 'object',
                        },
                      },
                    },
                  },
                }
              : {}),
          };
        } else {
          throw new Error(`Unexpected registered task request ${contract.method}`);
        }
        const parsed = await contract.resultSchema['~standard'].validate(result);
        if (parsed.issues) {
          throw new Error('Built task fixture returned an invalid registered result');
        }
        return parsed.value;
      },
    },
    configRef: 'fixture-ref',
    configuredServerId: serverId,
    generation: 1,
    registry,
    server: {
      name: serverId,
      protocol: '2026-07-28',
      startup: 'automatic',
      transport: 'streamable-http',
      url: 'https://tasks.example.test/mcp',
    },
  });
  const initial = await host.track({
    configuredServerId: serverId,
    result: {
      createdAt,
      lastUpdatedAt: createdAt,
      pollIntervalMs: 10,
      resultType: 'task',
      status: 'working',
      taskId: 'task-1',
      ttlMs: 60_000,
    },
    toolName: 'start_task',
  });
  status = 'input_required';
  await presented.promise;
  const result = await host.act({ action: 'cancel', handle: initial.handle });
  if (!result.ok) {
    throw new Error(result.diagnostic.message);
  }
  assert.deepEqual(result.task.handle, initial.handle);
  assert.equal(result.task.status, 'cancelled');
  assert.deepEqual(failures, []);
  process.stdout.write(JSON.stringify({ methods, status: result.task.status }));
} finally {
  await host?.close();
  await db.close();
}
