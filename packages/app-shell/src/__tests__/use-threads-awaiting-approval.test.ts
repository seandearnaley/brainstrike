import type { DbHandle } from '@brainstrike/db/react';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usePGliteDatabaseMock, usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteDatabaseMock: vi.fn(),
  usePGliteLiveQueryMock: vi.fn(),
}));

vi.mock('@brainstrike/db/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/db/react')>()),
  usePGliteDatabase: usePGliteDatabaseMock,
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));

import { useThreadsAwaitingApproval } from '../hooks/use-threads-awaiting-approval';

const RESOURCE_ID = 'resource-1';
const DATABASE = {} as unknown as DbHandle;

interface LiveQueryArgs {
  readonly cacheKey?: string;
  readonly clearOnDisable?: boolean;
  readonly enabled?: boolean;
  readonly params?: readonly unknown[];
  readonly query?: string;
}

/**
 * Routed BY `cacheKey`: the Threads panel runs a SECOND live-query projection
 * (`use-active-assistant-thread-ids`) whose rows are also `{ threadId }`. A
 * blanket mock would let one projection's rows satisfy the other's assertions.
 */
function routeByCacheKey(rowsByProjection: Readonly<Record<string, readonly unknown[]>>): void {
  usePGliteLiveQueryMock.mockImplementation((args: LiveQueryArgs) => {
    const cacheKey = args.cacheKey ?? '';
    const match = Object.entries(rowsByProjection).find(([prefix]) =>
      cacheKey.startsWith(`["${prefix}"`)
    );
    return {
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: match ? [...match[1]] : [],
    };
  });
}

function lastLiveQueryArgs(): LiveQueryArgs {
  return usePGliteLiveQueryMock.mock.calls.at(-1)?.[0] as LiveQueryArgs;
}

function renderAwaitingApproval(
  overrides: { readonly database?: DbHandle | null; readonly schemaReady?: boolean } = {}
) {
  return renderHook(() =>
    useThreadsAwaitingApproval({
      database: overrides.database === undefined ? DATABASE : overrides.database,
      resourceId: RESOURCE_ID,
      schemaReady: overrides.schemaReady ?? true,
    })
  );
}

beforeEach(() => {
  usePGliteDatabaseMock.mockReset();
  usePGliteLiveQueryMock.mockReset();
  usePGliteDatabaseMock.mockReturnValue(DATABASE);
  routeByCacheKey({ 'threads-awaiting-approval': [{ threadId: 'thread-a' }] });
});

describe('useThreadsAwaitingApproval', () => {
  it('projects the awaiting-approval rows of ITS OWN cache key only', () => {
    routeByCacheKey({
      'active-assistant-thread-ids': [{ threadId: 'thread-running' }],
      'threads-awaiting-approval': [{ threadId: 'thread-a' }, { threadId: 'thread-b' }],
    });

    const { result } = renderAwaitingApproval();

    expect([...result.current.threadIds].sort()).toEqual(['thread-a', 'thread-b']);
    expect(result.current.threadIds.has('thread-running')).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('keys the subscription on the resource id', () => {
    renderAwaitingApproval();

    expect(lastLiveQueryArgs().cacheKey).toBe(
      JSON.stringify(['threads-awaiting-approval', RESOURCE_ID])
    );
    expect(lastLiveQueryArgs().params).toEqual([RESOURCE_ID]);
  });

  it('selects unresolved approval pauses', () => {
    renderAwaitingApproval();
    const query = lastLiveQueryArgs().query ?? '';

    expect(query).toContain("kind = 'tool.approval.requested'");
    expect(query).toContain('NOT EXISTS');
    expect(query).toContain('AS "threadId"');
  });

  // RUN-AGNOSTIC PAIRING. The approval-resume leg mints a NEW runId and a NEW
  // `thread_runs` row, so the `tool.completed` / `tool.failed` that answers a
  // pause carries a DIFFERENT run_id than the pause itself. Pairing on `run_id`
  // (or on the per-run `sequence`, which is meaningless across two runs) could
  // never close the pause and would pin "needs you" on every thread that ever
  // asked.
  it('pairs a pause to its answer on toolCallId across runs, never on sequence', () => {
    renderAwaitingApproval();
    const query = lastLiveQueryArgs().query ?? '';

    expect(query).toContain("metadata->>'toolCallId'");
    expect(query).not.toContain('sequence');
  });

  // The ordering guard, and it EXCLUDES rather than pairs. Mastra gates
  // approval inside `toolCallStep`, so the pausing leg emits `tool.started` for
  // the same `toolCallId` BEFORE the pause row (order pinned in
  // `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`).
  // Without this, every pause answers itself and the glyph never lights.
  //
  // It is `occurred_at`-shaped, NOT `run_id`-shaped: with two gated calls in one
  // step the second call's pre-pause start lands on the leg BEFORE its own pause
  // row, so a same-run exclusion never fires for it. Whether that actually keeps
  // the thread lit is decided in the real-PGlite lane; a substring cannot say.
  it('never lets a tool.started that PRECEDES a pause answer it', () => {
    renderAwaitingApproval();
    const query = lastLiveQueryArgs().query ?? '';

    expect(query).toContain('answer.occurred_at > requested.occurred_at');
    expect(query).not.toContain('answer.run_id = requested.run_id');
  });

  it('treats every answer to a pause as a resolution, including the tool starting', () => {
    renderAwaitingApproval();
    const query = lastLiveQueryArgs().query ?? '';

    for (const kind of [
      'tool.started',
      'tool.completed',
      'tool.failed',
      'tool.resume.unsupported',
    ]) {
      expect(query).toContain(`'${kind}'`);
    }
  });

  // A leg that pauses for approval is written `status = 'completed'` (the pause
  // emits a normal `finishReason: 'tool-calls'` finish), while the Mastra
  // suspended snapshot — and the user's obligation — survive it. Joining
  // `thread_runs` on `status = 'running'` would make this projection ALWAYS
  // empty, and joining any other status would make a restart forget a pause
  // that is still genuinely pending.
  it('never reads the run row status, which a pause does not describe', () => {
    renderAwaitingApproval();
    const query = lastLiveQueryArgs().query ?? '';

    expect(query).not.toContain('brainstrike_assistant_thread_runs');
    expect(query).not.toContain('status');
  });

  // Both sides being NULL would make the equality NULL, the NOT EXISTS true,
  // and the badge permanent. A pause with no call id can never be answered by
  // anything, so it is excluded rather than pinned.
  it('ignores a pause row that carries no tool call id', () => {
    renderAwaitingApproval();

    expect(lastLiveQueryArgs().query ?? '').toContain(
      "requested.metadata->>'toolCallId' IS NOT NULL"
    );
  });

  it('stays disabled until the schema is bootstrapped', () => {
    renderAwaitingApproval({ schemaReady: false });

    expect(lastLiveQueryArgs().enabled).toBe(false);
  });

  it('stays disabled without a database handle', () => {
    renderAwaitingApproval({ database: null });

    expect(lastLiveQueryArgs().enabled).toBe(false);
  });

  it('enables the subscription once the handle and schema are ready', () => {
    renderAwaitingApproval();

    expect(lastLiveQueryArgs().enabled).toBe(true);
    expect(lastLiveQueryArgs().clearOnDisable).toBe(true);
  });

  it('surfaces a query failure and reports no thread ids', () => {
    const failure = new Error('live query failed');
    usePGliteLiveQueryMock.mockReturnValue({
      error: failure,
      loading: false,
      refresh: vi.fn(),
      rows: [{ threadId: 'thread-a' }],
    });

    const { result } = renderAwaitingApproval();

    expect(result.current.error).toBe(failure);
    expect(result.current.threadIds.size).toBe(0);
  });

  // NO SILENT FALLBACK: a malformed row must not be dropped while the rest of
  // the projection is presented as complete.
  it('fails the whole projection on an invalid thread id rather than skipping it', () => {
    routeByCacheKey({ 'threads-awaiting-approval': [{ threadId: 'thread-a' }, { threadId: 42 }] });

    const { result } = renderAwaitingApproval();

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.threadIds.size).toBe(0);
  });

  it('reports loading while the subscription is loading', () => {
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: true,
      refresh: vi.fn(),
      rows: [],
    });

    const { result } = renderAwaitingApproval();

    expect(result.current.loading).toBe(true);
  });
});
