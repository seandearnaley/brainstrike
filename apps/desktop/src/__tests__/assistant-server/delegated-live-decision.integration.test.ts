// @vitest-environment node
/**
 * Decisions delivered INTO the running leg (settled 2026-09-14, LIVE
 * DECISIONS), through the REAL desktop host, decision ledger and background
 * store: a parked child resumes inside the leg that is still streaming, a
 * session grant answers its parked siblings, an already-answered sibling is
 * skipped and a refused answer records nothing. The multi-approval matrix over
 * fresh legs is `delegated-sibling-grant.integration.test.ts`.
 */

import type { getToolActionTarget } from '@brainstrike/assistant-contract';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerLeafConcurrently,
  answerLeafInGrantWindow,
  type ChildSpec,
  createApprovalDatabase,
  decisionRowIds,
  decisionRows,
  deliverLive,
  type FanoutHolder,
  type FanoutShape,
  type Policy,
  persona,
  READ_ASK,
  setupFanout as setupFanoutWithHolder,
  stopSubtree,
  TWO,
} from './fixtures/delegated-approval-harness';

const holder = vi.hoisted(
  (): FanoutHolder => ({
    database: undefined,
    model: undefined,
  })
);
vi.mock('../../db-main', () => ({
  getDatabase: async () => {
    if (!holder.database) {
      throw new Error('Database not initialized');
    }
    return holder.database;
  },
}));
// Restore the real runtime: the desktop global setup installs inert agent mocks.
vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));
vi.mock('@brainstrike/agent/providers/provider-factory', async (original) => ({
  ...(await original<{ createProvider: typeof import('@brainstrike/agent')['createProvider'] }>()),
  createProvider: () => {
    if (!holder.model) {
      throw new Error('Model not initialized');
    }
    return holder.model;
  },
}));

/** Keeps every call site identical to the single-suite harness. */
const setupFanout = (
  database: PGlite,
  children: readonly ChildSpec[],
  shape?: FanoutShape
): ReturnType<typeof setupFanoutWithHolder> =>
  shape
    ? setupFanoutWithHolder(holder, database, children, shape)
    : setupFanoutWithHolder(holder, database, children);

describe('desktop live decisions through the real host ledger', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await holder.database?.close();
    holder.database = undefined;
    holder.model = undefined;
  });

  let database: PGlite;
  beforeEach(async () => {
    database = await createApprovalDatabase('memory://delegated-live-decision');
    holder.database = database;
  });

  it("a live-resumed child's frames never follow a terminal: its pause finish is held, its own finish is last", async () => {
    // thread-834924c1 (2026-09-14): the child parked at :16 and its pause
    // FINISH was published with the card; the live approve at :23 resumed it
    // in the same leg and its next frames arrived at :26 — after the child
    // view's terminal. The renderer closes a child on its finish frame and
    // tears the whole stream down on any later frame; the host then recorded
    // the run finished and every child died with `delegation-root-not-running`.
    // A parked child is not finished: its pause finish is held for the leg's
    // end and dropped when it resumes, so the only finish it ever sends is
    // its own, last.
    const hold = Promise.withResolvers<void>();
    const childChunks: string[] = [];
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (
            chunk.type === 'delegated-conversation-chunk' &&
            chunk.identity.parentToolCallId === 'delegate-2'
          ) {
            childChunks.push(
              chunk.chunk.type === 'message-finish'
                ? `message-finish:${chunk.chunk.finishReason}`
                : chunk.chunk.type
            );
          }
          if (
            chunk.type === 'tool-approval-required' &&
            chunk.toolCallId === 'delegate-2' &&
            !delivered
          ) {
            delivered = deliverLive(chunk).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    const finishes = childChunks.filter((type) => type.startsWith('message-finish'));
    expect(finishes).toEqual(['message-finish:stop']);
    expect(childChunks.at(-1)).toBe('message-finish:stop');
    // The resumed child's frames (its read result, its answer) came after the card.
    expect(childChunks.indexOf('tool-approval-required')).toBeLessThan(
      childChunks.lastIndexOf('tool-event')
    );
  });

  it('a decision delivered while a sibling still works resumes the parked child inside the running leg', async () => {
    // Claude Code delivers the answer into the live session; here a decision
    // used to start a NEW host leg and wait for the running one to settle.
    // Child 1's allowed read is held open; child 2's read asks; the approve
    // is delivered through the leg's registered control before child 1 is
    // released, so the whole turn completes in ONE leg.
    const hold = Promise.withResolvers<void>();
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (
            chunk.type === 'tool-approval-required' &&
            chunk.toolCallId === 'delegate-2' &&
            !delivered
          ) {
            delivered = deliverLive(chunk).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    const answered = fanout.initial.flatMap((chunk) =>
      chunk.type === 'tool-approval-answered' ? [chunk] : []
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      decision: 'approve',
      reason: 'user',
      toolCallId: 'delegate-2',
      toolName: 'brainstrike.readWorkspaceFile',
    });
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    const text = fanout.initial
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : []))
      .join('');
    expect(text).toContain('Parent: ALL-FLAGS');
  });

  it('a live "Allow reads this session" answers the parked sibling, and a child that reads afterwards never parks', async () => {
    // Child 1: allowed held grep, then an ask-gated read AFTER the grant
    // arrived. Child 2: ask-gated read, parked when the grant is delivered on
    // its card. Child 3: parked sibling answered by the grant. A lasting grant
    // applies to every later call (Claude Code): child 1's later read RUNS —
    // no card, no policy answer, no ledger row (it parked-then-auto-answered
    // before 2026-09-15, one suspension + resume per read: 70 cards on GLM).
    const hold = Promise.withResolvers<void>();
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const cards: string[] = [];
    const grant: Policy = {
      ...READ_ASK,
      perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
      sessionGrants: ['read'],
    };
    const fanout = await setupFanout(
      database,
      [
        { id: '1', next: 'brainstrike_readWorkspaceFile', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
        { id: '3', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (chunk.type !== 'tool-approval-required') {
            return;
          }
          cards.push(chunk.toolCallId);
          if (cards.includes('delegate-2') && cards.includes('delegate-3') && !delivered) {
            delivered = deliverLive(chunk, grant).finally(() => hold.resolve());
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(3);
    // Debug-pack evidence through the REAL host (migration 139): the running
    // leg's delivered decision is durable under its host run, naming the one
    // parked sibling the grant answered and the trusted grant it carried.
    const liveDecisions = await database.query<Record<string, unknown>>(
      `SELECT outcome, source, tool_call_id,
        jsonb_array_length(answered_sibling_task_ids) AS answered,
        policy_snapshot -> 'sessionGrants' AS grants
       FROM brainstrike_delegated_live_decisions`
    );
    expect(liveDecisions.rows).toEqual([
      {
        answered: 1,
        grants: ['read'],
        outcome: 'delivered',
        source: 'user',
        tool_call_id: expect.stringMatching(/^delegate-[23]$/u),
      },
    ]);
    // MUTATION GUARD: a gate that ignores the remembered grant parks child 1's
    // later read, so a third card ('delegate-1') arrives. Whether that card is
    // then auto-answered is pinned by the `answered` assertions below, not here.
    expect(cards.sort()).toEqual(['delegate-2', 'delegate-3']);
    const answered = fanout.initial
      .flatMap((chunk) => (chunk.type === 'tool-approval-answered' ? [chunk] : []))
      .map((chunk) => [chunk.toolCallId, chunk.reason] as const);
    expect(answered.map(([id]) => id).sort()).toEqual(['delegate-2', 'delegate-3']);
    expect(answered.filter(([, reason]) => reason === 'user')).toHaveLength(1);
    expect(answered.filter(([, reason]) => reason === 'session-grant')).toHaveLength(1);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
      { parent_tool_call_id: 'delegate-3', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    const text = fanout.initial
      .flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.value] : []))
      .join('');
    expect(text).toContain('Parent: ALL-FLAGS');
  });

  async function whenCardsParked<T>(
    children: readonly ChildSpec[],
    waitFor: readonly string[],
    act: (cards: ReadonlyMap<string, Parameters<typeof getToolActionTarget>[0]>) => Promise<T>
  ) {
    const hold = Promise.withResolvers<void>();
    const cards = new Map<string, Parameters<typeof getToolActionTarget>[0]>();
    let outcome: Promise<T> | undefined;
    const fanout = await setupFanout(database, children, {
      holdGrep: hold.promise,
      onInitialChunk: (chunk) => {
        if (chunk.type !== 'tool-approval-required') {
          return;
        }
        cards.set(chunk.toolCallId, chunk);
        if (outcome || !waitFor.every((id) => cards.has(id))) {
          return;
        }
        // The hold is released whatever `act` does, so a failure inside it
        // fails the assertion below instead of hanging the held child.
        outcome = act(cards).finally(() => hold.resolve());
      },
      persona,
      policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
    });
    expect(outcome, `the root cards ${waitFor.join(', ')} were never all parked`).toBeDefined();
    return { fanout, result: await (outcome as Promise<T>) };
  }

  const settle = (delivery: Promise<'delivered' | 'no-live-run'>): Promise<unknown> =>
    delivery.then(
      (value) => value,
      (error: unknown) => error
    );

  const READ_GRANT: Policy = {
    ...READ_ASK,
    perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
    sessionGrants: ['read'],
  };

  it("a live grant skips a sibling another decision already answered and still delivers the user's own answer", async () => {
    // BST-1749, PR #3209 review: an answered sibling is a legitimate state, not
    // a reason to refuse the user's click. Refusing it re-conflicted on every
    // retry that still carried the grant, so the card could never be answered.
    const { fanout, result } = await whenCardsParked(
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
        { id: '3', tool: 'brainstrike_readWorkspaceFile' },
        { id: '4', tool: 'brainstrike_readWorkspaceFile' },
      ],
      ['delegate-2', 'delegate-3', 'delegate-4'],
      async (cards) => {
        const user = cards.get('delegate-2');
        const answered = cards.get('delegate-3');
        if (!(user && answered)) {
          throw new Error('The parked cards are missing');
        }
        await answerLeafConcurrently(database, answered);
        return await settle(deliverLive(user, READ_GRANT));
      }
    );
    // MUTATION GUARD: treating an answered sibling as fatal refuses this.
    expect(result).toBe('delivered');
    // The already-answered sibling keeps its own row and stays parked; the
    // other sibling is answered by the grant.
    expect(await decisionRowIds(database, 'delegate-3')).toEqual(['concurrent-answer']);
    expect(await fanout.parkedTasks()).toEqual(['delegate-3']);
    expect(fanout.readFile).toHaveBeenCalledTimes(2);
    expect(
      fanout.initial.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [[chunk.toolCallId, chunk.reason]] : []
      )
    ).toEqual([
      ['delegate-2', 'user'],
      ['delegate-4', 'session-grant'],
    ]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
      { parent_tool_call_id: 'delegate-3', state: 'consumed' },
      { parent_tool_call_id: 'delegate-4', state: 'consumed' },
    ]);
  });

  it("a live grant skips a sibling whose subtree was stopped and still delivers the user's own answer", async () => {
    // BST-1749 follow-up: a Stop that does not reach
    // `cancelStoredBackgroundInvocations` (a crash, or the 503 any step of
    // `handleDelegatedCancelRequest` answers with the revocation already
    // committed) leaves the sibling's invocation row carrying
    // `cancellation_requested_at` while its background task is still
    // suspended — the startup reaper repairs `pending`/`running` tasks only.
    // Discovery therefore re-selects a task no write can ever accept, and
    // refusing over it refused the user's own card on EVERY retry that still
    // carried the grant: the permanent-refusal shape the answered-leaf skip
    // exists to prevent.
    const { fanout, result } = await whenCardsParked(
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
        { id: '3', tool: 'brainstrike_readWorkspaceFile' },
      ],
      ['delegate-2', 'delegate-3'],
      async (cards) => {
        const user = cards.get('delegate-2');
        const stopped = cards.get('delegate-3');
        if (!(user && stopped)) {
          throw new Error('The parked cards are missing');
        }
        await stopSubtree(database, stopped);
        return await settle(deliverLive(user, READ_GRANT));
      }
    );
    // MUTATION GUARD: refusing over the stopped sibling rejects this delivery.
    expect(result).toBe('delivered');
    // The stopped sibling is passed over, not answered: no ledger row of its
    // own and its task stays parked, while the user's own answer lands.
    expect(await decisionRowIds(database, 'delegate-3')).toEqual([]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-3']);
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    expect(
      fanout.initial.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [[chunk.toolCallId, chunk.reason]] : []
      )
    ).toEqual([['delegate-2', 'user']]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
  });

  it("a live grant refused on a sibling answered inside the write window records nothing: the user's own card stays answerable", async () => {
    // BST-1749 review: the running leg recorded the user's answer as consumed,
    // then the sibling's row was refused — leaving the user's pause consumed,
    // never resumed, and refused on every retry. A refusal that lands in the
    // window between discovery and the write stays fatal for the whole batch;
    // it is the only fatal per-sibling refusal left, since discovery skips a
    // leaf that is already answered or stopped when it READS.
    const { fanout, result } = await whenCardsParked(
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
        { id: '3', tool: 'brainstrike_readWorkspaceFile' },
      ],
      ['delegate-2', 'delegate-3'],
      async (cards) => {
        const user = cards.get('delegate-2');
        const sibling = cards.get('delegate-3');
        if (!(user && sibling)) {
          throw new Error('The parked cards are missing');
        }
        const raced = answerLeafInGrantWindow(database, sibling);
        const refusal = await settle(deliverLive(user, READ_GRANT));
        raced(refusal);
        const rowsAfterRefusal = await decisionRows(database);
        return { refusal, retried: await settle(deliverLive(user)), rowsAfterRefusal };
      }
    );
    expect(result.refusal).toMatchObject({ reason: 'tool-action-already-consumed-or-root-busy' });
    // MUTATION GUARD: recording the answers outside ONE transaction leaves a
    // consumed delegate-2 row beside the window's own delegate-3 row here.
    expect(result.rowsAfterRefusal).toEqual([
      { parent_tool_call_id: 'delegate-3', state: 'consumed' },
    ]);
    expect(result.retried).toBe('delivered');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    expect(
      fanout.initial.flatMap((chunk) =>
        chunk.type === 'tool-approval-answered' ? [[chunk.toolCallId, chunk.reason]] : []
      )
    ).toEqual([['delegate-2', 'user']]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
      { parent_tool_call_id: 'delegate-3', state: 'consumed' },
    ]);
  });

  it("an approval leg whose granted sibling is refused releases the user's claim: the card stays answerable", async () => {
    // BST-1749 review: the approval leg claimed the user's decision, then
    // answering the parked sibling its grant covers failed before any native
    // resume (here the sibling's leaf is answered inside the window between
    // discovery and the write, so the unique leaf key refuses its row);
    // disposal's `finishToolActions` turned the unexecuted claim into
    // `consumed`, so the user's card was refused for good.
    const fanout = await setupFanout(database, TWO);
    const raced = answerLeafInGrantWindow(database, fanout.notice('2'));
    const refusal = await fanout
      .decide(fanout.notice('1'), 'approve', { ...READ_ASK, sessionGrants: ['read'] })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    raced(refusal);
    // The leg's construction failure carries the host's refusal as its cause.
    expect(refusal).toMatchObject({
      cause: { reason: 'tool-action-already-consumed-or-root-busy' },
      code: 'mastra_agent_stream_failure',
    });
    expect(fanout.execute).not.toHaveBeenCalled();
    // MUTATION GUARD: without the release, disposal leaves delegate-1's claim
    // behind as a consumed row instead of no row at all.
    expect(await decisionRowIds(database, 'delegate-1')).toEqual([]);
    const retried = await fanout.decide(fanout.notice('1'), 'approve');
    expect(retried.answered).toEqual(['delegate-1']);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
  });

  it('a live session grant during an approval leg: one claimed decision, zero further policy rows, the resumed child reads on without a card', async () => {
    // Both children park on the initial leg. The user one-shot-approves card
    // 1 on a NEW leg (the ledger `claims` it; `finishToolActions` consumes it
    // when the leg ends). While that leg runs child 1's held grep, "Allow
    // reads this session" is delivered LIVE on card 2: child 2 resumes under
    // the grant (consumed), and child 1's NEXT read runs with no card and no
    // third ledger row.
    // MUTATION GUARD: the old flag-based gate parks child 1's next read on
    // this leg — `cards` gains 'delegate-1'.
    const hold = Promise.withResolvers<void>();
    const fanout = await setupFanout(
      database,
      [
        { id: '1', next: 'brainstrike_readWorkspaceFile', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      { holdGrep: hold.promise, persona, policy: READ_ASK }
    );
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2']);
    let delivered: Promise<'delivered' | 'no-live-run'> | undefined;
    const result = await fanout.decide(
      fanout.notice('1'),
      'approve',
      READ_ASK,
      (chunk, hostRunId) => {
        // The resumed child publishes no new frame until its held grep
        // returns; the leg's first run event is streamed after the runtime
        // armed its live decision seam, so the leg is live from here on.
        if (chunk.type === 'run-event' && !delivered) {
          delivered = deliverLive(
            fanout.notice('2'),
            { ...READ_ASK, sessionGrants: ['read'] },
            hostRunId
          ).finally(() => hold.resolve());
        }
      }
    );
    await expect(delivered).resolves.toBe('delivered');
    expect(result.cards).toEqual([]);
    expect(result.answered).toEqual(['delegate-1', 'delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(fanout.readFile).toHaveBeenCalledTimes(2);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  it('a decision delivered after the leg settled is not live and changes nothing', async () => {
    const fanout = await setupFanout(database, TWO);
    await expect(deliverLive(fanout.notice('1'))).resolves.toBe('no-live-run');
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.decisions()).toEqual([]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2']);
  });
});
