import { migrate, wasmLoader } from '@brainstrike/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestDatabase = Awaited<ReturnType<typeof wasmLoader.createPGlite>>;

// BST-1232 review (P2 belt-and-braces): proves the REAL SQL lookup — not a
// mocked `resolvePromptBaselineTokens` dependency, which every other test in
// conversation-compaction-trigger.integration.test.ts overrides — correctly
// skips a NEWER NULL-baseline row and falls back to an OLDER non-null one,
// against a real migrated PGlite database. `../../db-main` is mocked only in
// this file so `runPreRequestCompaction` reaches the genuine default
// dependency implementation instead of a stub. `vi.mock` is hoisted above
// this import by Vitest's transform regardless of source order (same
// pattern as db-ipc.test.ts), so the plain static import below still
// resolves against the mocked `../../db-main` binding.
const { testDbRef } = vi.hoisted(() => ({ testDbRef: { current: undefined as unknown } }));

vi.mock('../../db-main', () => ({
  getDatabase: async () => testDbRef.current,
}));

import { runPreRequestCompaction } from '../../assistant-server/conversation-compaction';

function fakeStore() {
  return {
    listMessages: vi.fn(async () => ({
      hasMore: false,
      messages: [],
      page: 0,
      perPage: false,
      total: 0,
    })),
    saveMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => ({ messages })),
  };
}

async function insertCalibrationRow(
  db: TestDatabase,
  input: {
    readonly id: string;
    readonly occurredAt: string;
    readonly promptBaselineTokens: number | null;
    readonly threadId: string;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO brainstrike_token_estimate_calibration
      (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
       final_step_prompt_tokens, prompt_baseline_tokens, occurred_at)
     VALUES ($1, $2, $3, 'gpt-5.6-terra', 'openai', 10, 20, $4, $5)`,
    [input.id, input.threadId, `run-${input.id}`, input.promptBaselineTokens, input.occurredAt]
  );
}

describe('conversation compaction baseline lookup NULL-safety (real PGlite)', () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      `memory://compaction-baseline-null-safety-${crypto.randomUUID()}`
    );
    testDbRef.current = db;
    await migrate(db);
  });

  it('uses the newest NON-NULL baseline row, skipping a newer NULL row', async () => {
    await insertCalibrationRow(db, {
      id: 'older-real',
      occurredAt: '2026-08-01T00:00:00.000Z',
      promptBaselineTokens: 15,
      threadId: 'thread-null-safety',
    });
    await insertCalibrationRow(db, {
      id: 'newer-null',
      occurredAt: '2026-08-02T00:00:00.000Z',
      promptBaselineTokens: null,
      threadId: 'thread-null-safety',
    });

    const runRecencyPrune = vi.fn(async () => ({ prunedCount: 0 }));
    const result = await runPreRequestCompaction(
      {
        memoryStore: fakeStore() as never,
        requestMessages: [],
        runId: 'run-1',
        runtimeData: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-null-safety' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
        signal: new AbortController().signal,
      },
      {
        // estimateVisibleTokens alone (80) sits below the 90% trigger
        // (90 = 0.9 * 100); only the real baseline (15) pushes the total to
        // 95, which crosses it. If the newer NULL row had shadowed the
        // older real one (falling back to baseline 0), the trigger would
        // NOT fire and runRecencyPrune would never be called.
        estimateVisibleTokens: vi.fn(() => 80),
        generateSummary: vi.fn(async () => {
          throw new Error('no real summarizer in this test');
        }),
        listCompactionRanges: vi.fn(async () => []),
        listToolProjectionRewrites: vi.fn(async () => new Map()),
        makeId: vi.fn(() => 'summary-1'),
        now: vi.fn(() => new Date('2026-08-09T12:00:00.000Z')),
        recordMessageParent: vi.fn(async () => undefined),
        recordRange: vi.fn(async () => undefined),
        resolveInputBudget: vi.fn(() => 100),
        runRecencyPrune,
        // resolvePromptBaselineTokens intentionally NOT overridden — the
        // real DB-backed default runs against the seeded rows above.
      } as never
    );

    expect(runRecencyPrune).toHaveBeenCalledOnce();
    // The summarizer always throws above; a retryable-looking failure noops
    // rather than committing a deterministic fallback, which is fine — the
    // assertion that matters here is that the trigger fired at all.
    expect(result).toEqual({ kind: 'noop' });
  });

  it('falls back to baseline 0 when every row for the thread is NULL', async () => {
    await insertCalibrationRow(db, {
      id: 'only-null',
      occurredAt: '2026-08-01T00:00:00.000Z',
      promptBaselineTokens: null,
      threadId: 'thread-all-null',
    });

    const runRecencyPrune = vi.fn(async () => ({ prunedCount: 0 }));
    const result = await runPreRequestCompaction(
      {
        memoryStore: fakeStore() as never,
        requestMessages: [],
        runId: 'run-2',
        runtimeData: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-all-null' },
          model: 'gpt-5.2',
          provider: 'openai',
        },
        signal: new AbortController().signal,
      },
      {
        estimateVisibleTokens: vi.fn(() => 80),
        generateSummary: vi.fn(async () => {
          throw new Error('unused');
        }),
        listCompactionRanges: vi.fn(async () => []),
        listToolProjectionRewrites: vi.fn(async () => new Map()),
        makeId: vi.fn(() => 'summary-1'),
        now: vi.fn(() => new Date('2026-08-09T12:00:00.000Z')),
        recordMessageParent: vi.fn(async () => undefined),
        recordRange: vi.fn(async () => undefined),
        resolveInputBudget: vi.fn(() => 100),
        runRecencyPrune,
      } as never
    );

    // No non-null baseline exists anywhere for this thread, so the lookup
    // correctly finds nothing (not an error), falls back to 0, and 80 alone
    // stays under the 90-token trigger.
    expect(runRecencyPrune).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'noop' });
  });
});
