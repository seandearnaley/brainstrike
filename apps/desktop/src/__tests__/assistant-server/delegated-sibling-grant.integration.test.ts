// @vitest-environment node
/**
 * The flow that failed live three times on 2026-09-14 (threads 22c3279b,
 * 796a942d), through the REAL desktop host, decision ledger and background
 * store: two specialists park on reads under `read: ask`; the user answers ONE
 * card with "Allow reads this session"; the sibling is answered by policy in
 * the same leg, both children run, the parent gets both results once. A
 * one-shot Approve answers only its own card. Live delivery into a running leg
 * is `delegated-live-decision.integration.test.ts`.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type ChildSpec,
  createApprovalDatabase,
  EDIT_ASK,
  type FanoutHolder,
  type FanoutShape,
  persona,
  READ_ASK,
  setupFanout as setupFanoutWithHolder,
  TWO,
  worker,
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

describe('desktop multi-approval scenarios through the real host ledger', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await holder.database?.close();
    holder.database = undefined;
    holder.model = undefined;
  });

  let database: PGlite;
  beforeEach(async () => {
    database = await createApprovalDatabase('memory://delegated-sibling-grant');
    holder.database = database;
  });

  it('every parked child has a root card and no tool ran before a decision', async () => {
    const fanout = await setupFanout(database, TWO);
    expect(fanout.rootNotices.map((chunk) => chunk.toolCallId).sort()).toEqual([
      'delegate-1',
      'delegate-2',
    ]);
    // Compare the independently persisted event and encoded notice from the real
    // native fan-out. Root transport IDs intentionally differ from child display IDs.
    const { createStatelessAssistantDataStreamResponse } = await import('@brainstrike/agent');
    const response = createStatelessAssistantDataStreamResponse(
      (async function* () {
        yield* fanout.initial;
      })(),
      { messageId: 'approval-owner-proof' }
    );
    const wire = await response.text();
    const dataPart = z.object({ data: z.unknown(), name: z.string() });
    const envelope = z.object({
      frames: z.array(z.object({ code: z.string(), value: z.unknown() })),
    });
    const approval = z.object({
      data: z.object({ timelineRunId: z.string(), toolCallId: z.string() }),
      name: z.literal('brainstrike.tool-approval'),
    });
    const mappedNotices = wire
      .split('\n')
      .filter((line) => line.startsWith('2:'))
      .flatMap((line) => z.array(dataPart).parse(JSON.parse(line.slice(2))))
      .filter((part) => part.name === 'brainstrike.delegated-conversation')
      .flatMap((part) => envelope.parse(part.data).frames)
      .flatMap((frame) => {
        const parsed = approval.safeParse(frame.value);
        return parsed.success ? [parsed.data.data] : [];
      });
    expect(mappedNotices).toHaveLength(2);
    let childNotices = 0;
    for (const chunk of fanout.initial) {
      if (
        chunk.type !== 'delegated-conversation-chunk' ||
        chunk.chunk.type !== 'tool-approval-required'
      ) {
        continue;
      }
      childNotices += 1;
      const notice = chunk.chunk;
      const pause = fanout.initial.find(
        (candidate) =>
          candidate.type === 'delegated-conversation-chunk' &&
          candidate.identity.childRuntimeRunId === chunk.identity.childRuntimeRunId &&
          candidate.chunk.type === 'run-event' &&
          candidate.chunk.event.kind === 'tool.approval.requested'
      );
      if (pause?.type !== 'delegated-conversation-chunk' || pause.chunk.type !== 'run-event') {
        throw new Error('Missing child approval event');
      }
      expect(pause.chunk.event.runId).not.toBe('host-leg');
      expect(notice).toMatchObject({
        hostRunId: 'host-leg',
        timelineRunId: pause.chunk.event.runId,
      });
      expect(notice.toolCallId).toBe(pause.chunk.event.metadata?.['toolCallId']);
      expect(mappedNotices).toContainEqual({
        timelineRunId: pause.chunk.event.runId,
        toolCallId: pause.chunk.event.metadata?.['toolCallId'],
      });
    }
    expect(childNotices).toBe(2);
    for (const notice of fanout.rootNotices) {
      expect(notice).toMatchObject({ hostRunId: 'host-leg', timelineRunId: 'host-leg' });
    }
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2']);
    // The user's status row (WAKEUP LEDGER, settled 2026-09-15) reached the
    // root thread through the real host stream, and the desktop persisted it.
    expect(
      fanout.initial.some((c) => c.type === 'run-event' && c.event.kind === 'delegation.ledger')
    ).toBe(true);
    expect(
      (
        await database.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM brainstrike_assistant_run_events WHERE kind = 'delegation.ledger'"
        )
      ).rows[0]?.n
    ).toBeGreaterThan(0);
  });

  it('"Allow reads this session" on one card answers the sibling in the same leg', async () => {
    const fanout = await setupFanout(database, TWO);
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    expect(result.answered).toEqual(['delegate-1', 'delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  it('a one-shot Approve answers only its card; approving the sibling next completes the turn', async () => {
    const fanout = await setupFanout(database, TWO);
    const first = await fanout.decide(fanout.notice('1'), 'approve');
    expect(first.answered).toEqual(['delegate-1']);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    expect(first.text).toContain('Parent: waiting');
    const second = await fanout.decide(fanout.notice('2'), 'approve');
    expect(second.answered).toEqual(['delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
    expect(second.text).toContain('Parent: ALL-FLAGS');
  });

  it('declining one card never runs its tool; a later grant on the sibling touches only the sibling', async () => {
    const fanout = await setupFanout(database, TWO);
    const declined = await fanout.decide(fanout.notice('1'), 'decline');
    expect(declined.answered).toEqual(['delegate-1']);
    expect(fanout.execute).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    const granted = await fanout.decide(fanout.notice('2'), 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    // Only the initiating sibling is answered; the declined child stays settled.
    expect(granted.answered).toEqual(['delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(await fanout.decisions()).toEqual([
      { parent_tool_call_id: 'delegate-1', state: 'consumed' },
      { parent_tool_call_id: 'delegate-2', state: 'consumed' },
    ]);
  });

  it('"Always allow <tool>" answers siblings parked on that tool and leaves a sibling on another tool parked', async () => {
    const fanout = await setupFanout(database, [
      { id: '1', tool: 'brainstrike_grepSearch' },
      { id: '2', tool: 'brainstrike_grepSearch' },
      { id: '3', tool: 'brainstrike_readWorkspaceFile' },
    ]);
    expect(await fanout.parkedTasks()).toEqual(['delegate-1', 'delegate-2', 'delegate-3']);
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...READ_ASK,
      perToolOverrides: { 'brainstrike.grepSearch': 'allow' },
    });
    expect(result.answered).toEqual(['delegate-1', 'delegate-2']);
    expect(fanout.execute).toHaveBeenCalledTimes(2);
    expect(fanout.readFile).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-3']);
    expect(result.text).toContain('Parent: waiting');
    const third = await fanout.decide(fanout.notice('3'), 'approve');
    expect(fanout.readFile).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(third.text).toContain('Parent: ALL-FLAGS');
  });

  it('after a reload the rediscovered root cards carry the same identity and a grant answers the sibling', async () => {
    const fanout = await setupFanout(database, TWO);
    const discovered = await fanout.discover();
    expect(discovered.approvals.map((entry) => entry.toolCallId).sort()).toEqual([
      'delegate-1',
      'delegate-2',
    ]);
    const rediscoveredFirst = discovered.approvals.find(
      (entry) => entry.toolCallId === 'delegate-1'
    );
    if (!rediscoveredFirst) {
      throw new Error('Rediscovery lost the first card');
    }
    expect(rediscoveredFirst.delegation).toEqual(fanout.notice('1').delegation);
    const result = await fanout.decide(rediscoveredFirst, 'approve', {
      ...READ_ASK,
      sessionGrants: ['read'],
    });
    expect(result.answered).toEqual(['delegate-1', 'delegate-2']);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  const TWO_WRITERS = [
    { id: '1', tool: 'brainstrike_writeWorkspaceFile' },
    { id: '2', tool: 'brainstrike_writeWorkspaceFile' },
  ] as const;

  it('worker writes: both children park on the edit, and "Allow edits this session" answers the sibling', async () => {
    const fanout = await setupFanout(database, TWO_WRITERS, { persona: worker, policy: EDIT_ASK });
    expect(fanout.rootNotices.map((chunk) => [chunk.toolCallId, chunk.toolName]).sort()).toEqual([
      ['delegate-1', 'brainstrike.writeWorkspaceFile'],
      ['delegate-2', 'brainstrike.writeWorkspaceFile'],
    ]);
    expect(fanout.rootNotices.map((chunk) => chunk.riskCategory)).toEqual(['edit', 'edit']);
    expect(fanout.writeFile).not.toHaveBeenCalled();
    const result = await fanout.decide(fanout.notice('1'), 'approve', {
      ...EDIT_ASK,
      sessionGrants: ['edit'],
    });
    expect(result.answered).toEqual(['delegate-1', 'delegate-2']);
    expect(fanout.writeFile).toHaveBeenCalledTimes(2);
    expect(await fanout.parkedTasks()).toEqual([]);
    expect(result.text).toContain('Parent: ALL-FLAGS');
  });

  it('worker writes: declining one write never runs it; a read grant on the other answers no write', async () => {
    const fanout = await setupFanout(database, TWO_WRITERS, { persona: worker, policy: EDIT_ASK });
    const declined = await fanout.decide(fanout.notice('1'), 'decline');
    expect(fanout.writeFile).not.toHaveBeenCalled();
    expect(declined.answered).toEqual(['delegate-1']);
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
    // A read grant adds no edit answers; the explicit approval still answers its own write.
    const second = await fanout.decide(fanout.notice('2'), 'approve', {
      ...EDIT_ASK,
      sessionGrants: ['read'],
    });
    expect(second.answered).toEqual(['delegate-2']);
    expect(fanout.writeFile).toHaveBeenCalledTimes(1);
    expect(await fanout.parkedTasks()).toEqual([]);
  });

  it("a parked child's root card publishes while a sibling is still working", async () => {
    // Claude Code surfaces a background subagent's prompt in the main session
    // the moment it asks; here three cards were held 77 s until the slowest
    // sibling returned (thread-4f14436f, 2026-09-14). Child 1's read is
    // allowed and held open; child 2's read asks. Its card must arrive
    // before child 1 is released.
    const hold = Promise.withResolvers<void>();
    let cardSeenWhileSiblingRan = false;
    let released = false;
    const fanout = await setupFanout(
      database,
      [
        { id: '1', tool: 'brainstrike_grepSearch' },
        { id: '2', tool: 'brainstrike_readWorkspaceFile' },
      ],
      {
        holdGrep: hold.promise,
        onInitialChunk: (chunk) => {
          if (chunk.type === 'tool-approval-required' && chunk.toolCallId === 'delegate-2') {
            cardSeenWhileSiblingRan = !released;
            released = true;
            hold.resolve();
          }
        },
        persona,
        policy: { ...READ_ASK, perToolOverrides: { 'brainstrike.grepSearch': 'allow' } },
      }
    );
    expect(cardSeenWhileSiblingRan).toBe(true);
    expect(fanout.execute).toHaveBeenCalledTimes(1);
    expect(fanout.readFile).not.toHaveBeenCalled();
    expect(await fanout.parkedTasks()).toEqual(['delegate-2']);
  });
});
