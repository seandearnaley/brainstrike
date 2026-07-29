/**
 * Direct-drive run-persistence tests (moved verbatim from the pre-split
 * assistant-server.integration.test.ts, BST-1028). PURE lane: the BST-972 A1
 * injection made the database provider a literal argument, so these need no
 * module mocks, no HTTP harness, and no real PGlite — the schema-backed
 * halves live in run-event-schema-provenance / hook-run-outcome integration
 * suites.
 */
import type { StreamChunk } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  observeDesktopAssistantRunEvents,
  persistDesktopChildRunUsage,
} from '../../assistant-server/run-persistence';

// File-local double — the pre-split suite shared one across every describe.
const mockDesktopDatabase = {
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(),
};

beforeEach(() => {
  mockDesktopDatabase.query.mockReset();
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
});

describe('run-event persistence tap transience', () => {
  it('passes a context-breakdown chunk through UNPERSISTED (transient, shell-output precedent)', async () => {
    const runId = 'run-breakdown-transience';
    const breakdownChunk = {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 9,
        provenance: 'heuristic',
        systemInstructionsTokens: 1234,
      },
      type: 'context-breakdown',
    } as unknown as StreamChunk;

    async function* source(): AsyncIterable<StreamChunk> {
      yield breakdownChunk;
      yield {
        event: {
          id: 'ev-1',
          kind: 'run.finished',
          label: 'Assistant run finished',
          status: 'completed',
          timestamp: '2026-07-18T00:00:00.000Z',
        },
        type: 'run-event',
      } as unknown as StreamChunk;
    }

    const seen: StreamChunk[] = [];
    for await (const chunk of observeDesktopAssistantRunEvents(
      source(),
      runId,
      [],
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }

    // Pass-through: the breakdown chunk reaches the mapper untouched.
    expect(seen[0]).toBe(breakdownChunk);
    // Never persisted: no INSERT parameter carries the breakdown figures,
    // while the run-event on the same stream WAS persisted.
    const persistedValues = mockDesktopDatabase.query.mock.calls
      .map((call) => call[1])
      .filter((params): params is unknown[] => Array.isArray(params))
      .flat();
    expect(persistedValues).not.toContain(1234);
    expect(persistedValues).toContain('run.finished');
  });
});

describe('child-run-usage durable persistence (BST-953)', () => {
  function usageInsertCalls(): unknown[][] {
    return mockDesktopDatabase.query.mock.calls
      .filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('INSERT INTO brainstrike_assistant_run_usage')
      )
      .map((call) => call[1] as unknown[]);
  }

  async function drive(
    chunks: StreamChunk[],
    observerTarget: { model: string; provider: string } | undefined
  ): Promise<StreamChunk[]> {
    async function* source(): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    const seen: StreamChunk[] = [];
    for await (const chunk of persistDesktopChildRunUsage(
      source(),
      'run-child-usage',
      observerTarget,
      async () => mockDesktopDatabase
    )) {
      seen.push(chunk);
    }
    return seen;
  }

  it('persists a subagent chunk as a run_kind=subagent row and forwards it', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: {
        estimated: false,
        inputTokens: 42,
        model: 'gpt-5.2',
        outputTokens: 7,
        personaId: 'explore',
        provider: 'openai',
        source: 'subagent',
      },
    } as unknown as StreamChunk;

    const seen = await drive([chunk], undefined);

    expect(seen[0]).toBe(chunk);
    const inserts = usageInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.arrayContaining(['run-child-usage', 'gpt-5.2', 'openai', 42, 7, 'subagent'])
    );
  });

  it('attributes an OM cycle row to the RESOLVED OBSERVER target, never the chat model', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: {
        estimated: true,
        inputTokens: 24_000,
        outputTokens: 900,
        source: 'om-observation',
      },
    } as unknown as StreamChunk;

    await drive([chunk], { model: 'google/gemini-2.5-flash', provider: 'openrouter' });

    const inserts = usageInsertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.arrayContaining([
        'run-child-usage',
        'google/gemini-2.5-flash',
        'openrouter',
        24_000,
        900,
        'om-observation',
      ])
    );
  });

  it('drops an unattributable OM row visibly (no observer target) but still forwards the chunk', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: { estimated: true, inputTokens: 100, outputTokens: 10, source: 'om-reflection' },
    } as unknown as StreamChunk;

    const seen = await drive([chunk], undefined);

    expect(seen[0]).toBe(chunk);
    expect(usageInsertCalls()).toHaveLength(0);
  });

  it('skips local-observer rows (local inference is unbilled)', async () => {
    const chunk = {
      type: 'child-run-usage',
      value: { estimated: true, inputTokens: 100, outputTokens: 10, source: 'om-observation' },
    } as unknown as StreamChunk;

    await drive([chunk], { model: 'gemma-3n', provider: 'local' });

    expect(usageInsertCalls()).toHaveLength(0);
  });
});
