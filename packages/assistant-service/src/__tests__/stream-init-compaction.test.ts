import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  runConversationCompactionBeforeStream,
  trustedCompactionOverlayFields,
  withCompactionUsageChunk,
} from '../stream-init-compaction.js';

function makeLogger() {
  const warn = vi.fn();
  return {
    logger: { info: vi.fn(), warn } as unknown as ScopedLogger,
    warn,
  };
}

async function* streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe('runConversationCompactionBeforeStream', () => {
  function makeInput(overrides: Record<string, unknown> = {}) {
    const runtime = {} as unknown as RuntimeData;
    const createContextOverflowRecovery = vi.fn(() => ({ armed: true }));
    const runPreRequest = vi.fn(async () => ({ kind: 'noop' as const }));
    const logger = makeLogger();
    return {
      createContextOverflowRecovery,
      input: {
        capabilities: {
          compaction: { createContextOverflowRecovery, runPreRequest },
        },
        logger: logger.logger,
        memoryResult: { store: { id: 'store-1' } },
        messages: [] as AgentMessage[],
        runId: 'run-1',
        runtime,
        signal: new AbortController().signal,
        ...overrides,
      },
      logger,
      runPreRequest,
      runtime,
    };
  }

  it('is a no-op without a memory result and never arms overflow recovery', async () => {
    const { input, createContextOverflowRecovery } = makeInput({ memoryResult: undefined });
    await expect(runConversationCompactionBeforeStream(input as never)).resolves.toBeUndefined();
    expect(createContextOverflowRecovery).not.toHaveBeenCalled();
  });

  it('arms context-overflow recovery and forwards the prepared inputs to the pre-request pass', async () => {
    const { input, runtime, runPreRequest, createContextOverflowRecovery } = makeInput();
    const result = await runConversationCompactionBeforeStream(input as never);

    expect(runtime.contextOverflowRecovery).toEqual({ armed: true });
    expect(createContextOverflowRecovery).toHaveBeenCalledWith({
      memoryStore: { id: 'store-1' },
      runtimeData: runtime,
    });
    expect(result).toEqual({ kind: 'noop' });
    expect(runPreRequest).toHaveBeenCalledWith(
      expect.objectContaining({ memoryStore: { id: 'store-1' }, runId: 'run-1' })
    );
  });

  it('surfaces compaction usage so it can be prepended onto the turn stream', async () => {
    const usage = {
      estimated: false,
      inputTokens: 3,
      outputTokens: 5,
      source: 'compaction-summary' as const,
    };
    const { input } = makeInput();
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'deterministic',
      usage,
    });

    await expect(runConversationCompactionBeforeStream(input as never)).resolves.toEqual({
      kind: 'deterministic',
      usage,
    });
  });
  it('logs and continues the user turn when the pre-request pass fails', async () => {
    const failure = new Error('compactor exploded');
    const { input, logger } = makeInput();
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      failure
    );

    await expect(runConversationCompactionBeforeStream(input as never)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Pre-request conversation compaction failed; continuing the user turn.',
      expect.objectContaining({
        code: 'conversation_compaction_pre_request_failed',
        error: failure,
      })
    );
  });
});

describe('withCompactionUsageChunk', () => {
  it('returns the source untouched when there is no usage to report', async () => {
    const source = streamOf([]);
    expect(withCompactionUsageChunk(source, undefined)).toBe(source);
    expect(withCompactionUsageChunk(source, {})).toBe(source);
  });

  it('prepends exactly one child-run-usage chunk ahead of the real stream', async () => {
    const tail: StreamChunk[] = [{ type: 'text-delta', value: 'hello' } as unknown as StreamChunk];
    const usage = {
      estimated: true,
      inputTokens: 7,
      outputTokens: 2,
      source: 'om-observation' as const,
    };

    const combined = withCompactionUsageChunk(streamOf(tail), { usage });
    const observed: StreamChunk[] = [];
    for await (const chunk of combined) {
      observed.push(chunk);
    }

    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({ type: 'child-run-usage', value: usage });
    expect(observed[1]).toEqual(tail[0]);
  });
});

describe('trustedCompactionOverlayFields', () => {
  it('carries the overlay lookup only when one exists', async () => {
    const lookup = {
      listActiveCompactionRanges: vi.fn(async (_threadId: string) => []),
    };
    expect(trustedCompactionOverlayFields(lookup)).toEqual({ compactionOverlayLookup: lookup });
    expect(trustedCompactionOverlayFields(undefined)).toEqual({});
    await lookup.listActiveCompactionRanges('thread-1');
    expect(lookup.listActiveCompactionRanges).toHaveBeenCalledWith('thread-1');
  });
});
