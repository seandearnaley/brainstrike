import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test, vi } from 'vitest';
import { attachAgentHost } from '../dist/client.js';
import {
  createProductionHostPlatform,
  type HostMemoryPreconditions,
  type ProductionHostPlatformOptions,
} from '../dist/production-platform.js';
import { startAgentHost } from '../dist/runtime.js';
import type { HostMcpRuntime } from '../src/ports.js';

/**
 * The production composition's thread/memory/read: only the preconditions run.
 * Every acquisition entry point (the full selection, MCP discovery and so the
 * model warmup that follows it) is counted and must stay at zero.
 */
async function readThroughProductionHost(preconditions: HostMemoryPreconditions) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-production-memory-read-')));
  const readConfiguration = vi.fn<ProductionHostPlatformOptions['readConfiguration']>(async () => {
    throw new Error('A memory read must not acquire a selection');
  });
  const executableTools = vi.fn<HostMcpRuntime['executableTools']>(async () => {
    throw new Error('A memory read must not discover MCP tools');
  });
  const readMemoryPreconditions = vi.fn<
    NonNullable<ProductionHostPlatformOptions['readMemoryPreconditions']>
  >(async () => preconditions);
  const mcp = {
    close: vi.fn(),
    executableTools,
  } as unknown as HostMcpRuntime;
  const host = await startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      mcp,
      readConfiguration,
      readMemoryPreconditions,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveProviderAuth: async () => {
        throw new Error('A memory read must not resolve provider auth');
      },
      startup,
    })
  );
  const client = await attachAgentHost(host.record);
  try {
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const result = await client.request('thread/memory/read', {
      modelId: 'openai::gpt-6-sol',
      threadId,
    });
    return { executableTools, readConfiguration, readMemoryPreconditions, result };
  } finally {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
}

test('a memory read runs only the preconditions: no selection, MCP discovery or warmup', async () => {
  const read = await readThroughProductionHost({
    observation: { resourceId: 'workspace', scope: 'thread', state: 'on' },
    ready: true,
  });
  expect(read.result).toEqual({
    admission: { ready: true },
    observational: { record: null, state: 'active' },
  });
  expect(read.readMemoryPreconditions).toHaveBeenCalledTimes(1);
  expect(read.readConfiguration).not.toHaveBeenCalled();
  expect(read.executableTools).not.toHaveBeenCalled();
});

test('a failed precondition is the readiness reason', async () => {
  const reason = 'The embedding host is not running.';
  const read = await readThroughProductionHost({ ready: false, reason });
  expect(read.result).toEqual({ admission: { ready: false, reason } });
  expect(read.readConfiguration).not.toHaveBeenCalled();
});
