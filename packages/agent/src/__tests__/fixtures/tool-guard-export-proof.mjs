import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveGuardedToolSignal } from '@brainstrike/agent';
import { createMcpRuntimeClient } from '@brainstrike/agent/mcp-client';
import { guardToolExecution } from '@brainstrike/agent/tool-runtime';

// A subprocess resolves actual package exports without Vitest's source aliases.
const require = createRequire(import.meta.url);
const common = require('@brainstrike/agent');
const commonRuntime = require('@brainstrike/agent/tool-runtime');
const keeper = setTimeout(() => {
  throw new Error('Emitted guard proof exceeded its bound');
}, 5000);
try {
  for (const [guard, resolve] of [
    [guardToolExecution, common.resolveGuardedToolSignal],
    [commonRuntime.guardToolExecution, resolveGuardedToolSignal],
  ]) {
    const done = Promise.withResolvers();
    let observed;
    const tool = guard(
      {
        execute: async (_input, context) => {
          observed = resolve(context);
          await done.promise;
        },
      },
      { timeoutMs: 10, toolName: 'published-guard' }
    );
    try {
      const result = await tool.execute({}, Object.freeze({ toolCallId: 'call_1' }));
      assert.equal(result.error.code, 'tool_timeout');
      assert.ok(observed instanceof AbortSignal);
      assert.equal(observed.aborted, true);
    } finally {
      done.resolve();
    }
  }

  let physicalSignal;
  const physicalDone = Promise.withResolvers();
  const host = {
    invoke: async (operation, options) => {
      if (operation.type === 'tools/list') {
        return {
          result: { tools: [{ inputSchema: { type: 'object' }, name: 'probe' }] },
          type: 'tools/list',
        };
      }
      assert.equal(operation.type, 'tools/call');
      physicalSignal = options.signal;
      await new Promise((resolve) => {
        physicalSignal.addEventListener('abort', resolve, { once: true });
      });
      physicalDone.resolve();
      return { result: { content: [{ text: 'cancelled', type: 'text' }] }, type: 'tools/call' };
    },
    snapshot: () => ({
      revision: 1,
      servers: [
        {
          configuredProtocol: 'legacy',
          configuredServerId: 'published',
          generation: 1,
          state: 'disconnected',
          transport: 'stdio',
        },
      ],
    }),
    watch: () => () => undefined,
  };
  const runtime = await createMcpRuntimeClient({ config: undefined, host });
  try {
    const discovered = await runtime.listToolsetsWithErrors();
    assert.deepEqual(discovered.errors, {});
    const source = discovered.toolsets.published.probe;
    const guarded = guardToolExecution(source, { timeoutMs: 10, toolName: 'published-mcp' });
    const caller = new AbortController();
    const result = await guarded.execute({}, { abortSignal: caller.signal, toolCallId: 'call_1' });
    assert.equal(result.error.code, 'tool_timeout');
    assert.ok(physicalSignal instanceof AbortSignal);
    assert.equal(physicalSignal.aborted, true);
    assert.equal(caller.signal.aborted, false);
    await physicalDone.promise;
  } finally {
    await runtime.disconnect();
  }
  process.stdout.write(
    'PASS: ESM/CJS root, tool-runtime and MCP exports share deadline ownership.\n'
  );
} finally {
  clearTimeout(keeper);
}
