import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TRACKED_COMPACTION_FAILURES,
  type PreRequestCompactionOutcome,
  runConversationCompactionBeforeStream,
  trustedCompactionOverlayFields,
  withCompactionPreludeChunks,
} from '../stream-init-compaction.js';

/**
 * BST-1737's breadcrumb is latched to once per (thread, reason) in a
 * module-level set, exactly like the `warnedBaselineExceedsTargetThreadIds`
 * precedent it mirrors. Tests that must see a FRESH latch therefore mint a
 * fresh thread id; the de-duplication test deliberately reuses one.
 */
let nextThreadId = 0;
function freshThreadId(): string {
  nextThreadId += 1;
  return `thread-${nextThreadId}`;
}

function runEventOf(breadcrumb: PreRequestCompactionOutcome['failure']) {
  return (breadcrumb?.chunk as { event?: Record<string, unknown> } | undefined)?.event;
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const observed: StreamChunk[] = [];
  for await (const chunk of source) {
    observed.push(chunk);
  }
  return observed;
}

/**
 * Drive the outcome's prelude the way a live turn does — through
 * `withCompactionPreludeChunks`, fully drained. This is the ONLY thing that
 * arms the (thread, reason) latch, so a test that expects the latch to be armed
 * has to actually deliver the row.
 */
function deliverPrelude(outcome: PreRequestCompactionOutcome): Promise<StreamChunk[]> {
  return collect(withCompactionPreludeChunks(streamOf([]), outcome));
}

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
    const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
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
    await expect(runConversationCompactionBeforeStream(input as never)).resolves.toEqual({});
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
    expect(result).toEqual({ result: { kind: 'noop' } });
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
      result: { kind: 'deterministic', usage },
    });
  });

  it('mints NO breadcrumb when the pre-request pass succeeds (BST-1737)', () => {
    // The counterweight to the failure tests below: an always-visible row on a
    // healthy turn is noise, and noise is how a real signal gets ignored.
    return (async () => {
      const { input } = makeInput();
      const outcome = await runConversationCompactionBeforeStream(input as never);
      expect(outcome.failure).toBeUndefined();
    })();
  });
  it('logs, keeps the turn alive, AND mints a visible breadcrumb when the pass fails', async () => {
    const failure = new Error('Unknown compaction input budget for ollama/mystery.');
    const { input, logger } = makeInput();
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      failure
    );

    // TURN SURVIVES: the call RESOLVES rather than rethrowing. Degrading
    // gracefully is correct — degrading invisibly is what BST-1737 fixes.
    const outcome = await runConversationCompactionBeforeStream(input as never);
    expect(outcome.result).toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Pre-request conversation compaction failed; continuing the user turn.',
      expect.objectContaining({
        code: 'conversation_compaction_pre_request_failed',
        error: failure,
      })
    );

    const event = runEventOf(outcome.failure);
    expect(event).toMatchObject({
      detail:
        'This turn was sent without pre-request compaction — Unknown compaction input budget for ollama/mystery.',
      kind: 'compaction.failed',
      label: 'Conversation compaction unavailable',
      metadata: { reason: 'Unknown compaction input budget for ollama/mystery.' },
      // NEVER 'running': the pass has already finished (by throwing), so there
      // is no span to close and the row can never spin. Pinned here because the
      // assistant-ui pairing contract can only force the kind to be CLASSIFIED,
      // not check the classification against this emitter.
      status: 'failed',
    });
  });

  it.each([
    [
      'a missing trusted overlay lookup',
      'Conversation compaction requires the trusted compaction overlay lookup.',
    ],
    [
      'a malformed agentLoop.inputTokenLimit (BST-1707)',
      'Conversation compaction received an invalid agentLoop.inputTokenLimit (0) for openrouter/x.',
    ],
    ['a range/parent write failure', 'Assistant message m-1 has conflicting branch topology.'],
  ])('reports %s rather than swallowing it', async (_name, message) => {
    const { input } = makeInput();
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(message)
    );

    const outcome = await runConversationCompactionBeforeStream(input as never);
    expect(runEventOf(outcome.failure)).toMatchObject({
      kind: 'compaction.failed',
      metadata: { reason: message },
    });
  });

  it('redacts credentials out of the durable, rendered reason', async () => {
    const { input } = makeInput();
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('compaction store read failed for https://user:hunter2@db.test/x?token=sk-live')
    );

    const outcome = await runConversationCompactionBeforeStream(input as never);
    const event = runEventOf(outcome.failure);
    expect(event).toBeDefined();
    const serialized = JSON.stringify(event);
    expect(serialized).toContain('[redacted]');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-live');
  });

  it('never latches a turn with no thread id, so one row cannot silence another conversation', async () => {
    // Bucketing every unidentified turn under one shared key would let a
    // delivered row permanently silence a DIFFERENT conversation failing the
    // same way — the invariant the reason-keying exists to protect, broken in
    // the one case where the latch knows least.
    const anonymous = () => {
      const harness = makeInput({ runtime: { memory: {} } as unknown as RuntimeData });
      (
        harness.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('anonymous budget derivation exploded'));
      return harness;
    };

    const first = await runConversationCompactionBeforeStream(anonymous().input as never);
    expect(await deliverPrelude(first)).toHaveLength(1);
    const second = await runConversationCompactionBeforeStream(anonymous().input as never);

    expect(runEventOf(second.failure)).toMatchObject({
      metadata: { reason: 'anonymous budget derivation exploded' },
    });
    expect(await deliverPrelude(second)).toHaveLength(1);
    const third = await runConversationCompactionBeforeStream(anonymous().input as never);
    expect(third.failure).toBeDefined();
  });

  it('keeps a thread/reason boundary that bare concatenation would collapse', async () => {
    // The latch key is length-framed rather than delimited by an "impossible"
    // character — the previous NUL separator was unpublishable downstream (see
    // the comment on the key). Length framing has to actually hold the
    // boundary: `<base>ab` + `c` and `<base>a` + `bc` concatenate to the same
    // string, and collapsing them would let one thread's row silence another's.
    const base = freshThreadId();
    const wide = makeInput({
      runtime: { memory: { threadId: `${base}ab` } } as unknown as RuntimeData,
    });
    (
      wide.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('c'));
    const narrow = makeInput({
      runtime: { memory: { threadId: `${base}a` } } as unknown as RuntimeData,
    });
    (
      narrow.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('bc'));

    const first = await runConversationCompactionBeforeStream(wide.input as never);
    expect(await deliverPrelude(first)).toHaveLength(1);
    const second = await runConversationCompactionBeforeStream(narrow.input as never);

    expect(runEventOf(second.failure)).toMatchObject({ metadata: { reason: 'bc' } });
  });

  it('does NOT latch a breadcrumb the stream never delivered (Codex review of #3119)', async () => {
    // The latch used to be armed while the outcome was merely being
    // CONSTRUCTED — before `initializeAgentStream` awaits
    // `resolveInitialAgentStream` and before anything consumes the returned
    // stream. A rejection there, or a stream nobody reads, left the row
    // reaching neither `observe()` nor persistence while every later turn with
    // the same thread and reason stayed silent for the life of the process:
    // this ticket's own defect, reborn inside its fix.
    const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
    const reason = 'budget derivation exploded';
    const failing = (harness: ReturnType<typeof makeInput>) => {
      (
        harness.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error(reason));
      return harness;
    };

    // Turn 1: the outcome is built, then stream construction throws — the
    // prelude is never even wrapped, exactly as `initializeAgentStream`'s catch
    // discards it.
    const dropped = await runConversationCompactionBeforeStream(
      failing(makeInput({ runtime })).input as never
    );
    expect(dropped.failure).toBeDefined();

    // Turn 2: the wrapped stream IS constructed and then abandoned unread.
    const abandoned = await runConversationCompactionBeforeStream(
      failing(makeInput({ runtime })).input as never
    );
    expect(abandoned.failure).toBeDefined();
    withCompactionPreludeChunks(streamOf([]), abandoned);

    // Turn 3 still speaks: neither undelivered row may silence the thread.
    const delivered = await runConversationCompactionBeforeStream(
      failing(makeInput({ runtime })).input as never
    );
    expect(runEventOf(delivered.failure)).toMatchObject({
      kind: 'compaction.failed',
      metadata: { reason },
    });

    // And once it IS delivered, the latch arms: the next identical turn is
    // silent, so the fix does not simply disable the de-duplication.
    expect(await deliverPrelude(delivered)).toHaveLength(1);
    const repeat = await runConversationCompactionBeforeStream(
      failing(makeInput({ runtime })).input as never
    );
    expect(repeat.failure).toBeUndefined();
  });

  it('reports each thread+reason ONCE, and still reports a NEW reason on that thread', async () => {
    // A sticky cause (unknown model, missing overlay lookup, malformed
    // agentLoop) fails identically on every turn. Unlatched, a thread in that
    // state grows one identical always-visible row per turn forever, which
    // pushes real content out of the timeline and trains the user to ignore it.
    // Keyed on the REASON, never the thread alone, so the latch can never hide
    // a DIFFERENT failure — that would recreate this ticket inside its own fix.
    const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
    const first = makeInput({ runtime });
    (
      first.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('budget derivation exploded'));
    const second = makeInput({ runtime });
    (
      second.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('budget derivation exploded'));
    const other = makeInput({ runtime });
    (
      other.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('summary schema validation failed'));

    const one = await runConversationCompactionBeforeStream(first.input as never);
    // The latch arms on DELIVERY, never on construction, so the first turn's
    // row has to actually reach a consumer before the second turn can be
    // deduplicated against it.
    expect(await deliverPrelude(one)).toHaveLength(1);
    const two = await runConversationCompactionBeforeStream(second.input as never);
    const three = await runConversationCompactionBeforeStream(other.input as never);

    expect(one.failure).toBeDefined();
    expect(two.failure).toBeUndefined();
    expect(runEventOf(three.failure)).toMatchObject({
      metadata: { reason: 'summary schema validation failed' },
    });

    // The `warn` is NOT latched: per-turn operator evidence never disappears.
    expect(second.logger.warn).toHaveBeenCalledTimes(1);
  });

  /**
   * One failing turn on `runtime`, with its prelude fully DRAINED so the latch
   * actually arms — BST-1737 arms on delivery, never on mint, so a dedupe test
   * that skips the drain would pass without ever exercising the latch.
   * Resolves to the rendered reason when a row was minted, undefined when the
   * latch suppressed it.
   */
  async function failingTurnRejectingWith(
    runtime: RuntimeData,
    thrown: unknown
  ): Promise<string | undefined> {
    const { input } = makeInput({ runtime });
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      thrown
    );
    const outcome = await runConversationCompactionBeforeStream(input as never);
    await deliverPrelude(outcome);
    const metadata = runEventOf(outcome.failure)?.['metadata'] as { reason?: string } | undefined;
    return metadata?.reason;
  }

  function failingTurn(runtime: RuntimeData, message: string): Promise<string | undefined> {
    return failingTurnRejectingWith(runtime, new Error(message));
  }

  /**
   * BST-1744. The latch used to key on the whole bounded reason, so the two
   * reachable throws that embed a per-message id defeated it outright: a new
   * key every turn, hence a row every turn and an entry every turn.
   */
  describe('BST-1744: the key is the SHAPE of the throw, not its literal text', () => {
    function uuid(n: number): string {
      return `0199aa11-0000-7000-8000-${String(n).padStart(12, '0')}`;
    }

    it('deduplicates a reason whose only variable part is a per-message id', async () => {
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const candidate = (id: string) => `Compaction candidate ${id} has no valid creation time.`;

      const first = await failingTurn(runtime, candidate(uuid(1)));
      const second = await failingTurn(runtime, candidate(uuid(2)));
      const otherKind = await failingTurn(
        runtime,
        `Assistant message ${uuid(3)} has conflicting branch topology.`
      );

      // The ROW still renders the id verbatim — normalization is key-only, so
      // the user keeps the one fact that identifies the wedged message.
      expect(first).toBe(candidate(uuid(1)));
      expect(second).toBeUndefined();
      // Two different ids collapse; two different KINDS must not. This is the
      // assertion that stops a future over-broad masker silencing a real
      // second failure on an already-reported thread.
      expect(otherKind).toBe(`Assistant message ${uuid(3)} has conflicting branch topology.`);
    });

    it('deduplicates a reason whose only variable part is a timestamp', async () => {
      // Evidenced by run-events.test.ts, whose compaction fixture carries a
      // creation time: a driver error quoting one changes on every turn.
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const at = (stamp: string) => `Compaction candidate has no valid creation time: ${stamp}`;

      expect(await failingTurn(runtime, at('2026-09-10T18:46:26Z'))).toBeDefined();
      expect(await failingTurn(runtime, at('2026-09-11T07:02:00Z'))).toBeUndefined();
    });

    it('never merges two model names that differ only in a short digit run', async () => {
      // `ollama/llama3.2` and `ollama/llama3.3` are DIFFERENT failures. A
      // blanket digit mask would let the first permanently silence the second,
      // which is the one thing this latch must never do. Short digit runs are
      // therefore deliberately NOT volatile tokens.
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const budget = (model: string) => `Unknown compaction input budget for ollama/${model}.`;

      expect(await failingTurn(runtime, budget('llama3.2'))).toBe(budget('llama3.2'));
      expect(await failingTurn(runtime, budget('llama3.3'))).toBe(budget('llama3.3'));
    });

    it('keeps two failures apart when they differ only past the rendered reason bound', async () => {
      // `boundRunEventReason` truncates the RENDERED reason to 200 code points.
      // A key built from that truncation collapses these two onto one entry and
      // lets the first silence the second, so the key is built from the
      // untruncated message instead.
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const shared = `compaction store read failed: ${'detail '.repeat(40)}`;
      expect(shared.length).toBeGreaterThan(200);

      expect(await failingTurn(runtime, `${shared}alpha`)).toBeDefined();
      expect(await failingTurn(runtime, `${shared}beta`)).toBeDefined();
    });

    it('deduplicates a reason whose only variable part is a rotating credential', async () => {
      // The key is built from the untruncated message, so it must still run the
      // SAME redaction the rendered reason gets. Otherwise a rotating secret
      // mints a new key every rotation — BST-1744's own defect, relocated from
      // ids to credentials. (Claude review of #3138, finding 2.)
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const query = (token: string) =>
        `compaction store read failed: https://db.test/x?token=${token}`;

      expect(await failingTurn(runtime, query('sk-live-aaaaaa'))).toBeDefined();
      expect(await failingTurn(runtime, query('sk-live-bbbbbb'))).toBeUndefined();

      const userinfo = (secret: string) =>
        `compaction store read failed: postgres://svc:${secret}@db.test/brainstrike`;
      expect(await failingTurn(runtime, userinfo('rotating-one'))).toBeDefined();
      expect(await failingTurn(runtime, userinfo('rotating-two'))).toBeUndefined();
    });

    it('keys a non-Error throw from the same text the row renders', async () => {
      // ONE extraction, shared with the row. A key that re-derived the text as
      // `String(error)` would hand an Error and the bare string `Error: <msg>`
      // the SAME key while the two rows render DIFFERENT reasons — so one would
      // silence a row the user would have read as distinct. (Finding 3.)
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;

      expect(await failingTurnRejectingWith(runtime, new Error('compaction pass rejected'))).toBe(
        'compaction pass rejected'
      );
      expect(await failingTurnRejectingWith(runtime, 'Error: compaction pass rejected')).toBe(
        'Error: compaction pass rejected'
      );
    });

    it('evicts the oldest entry once the latch reaches its cap', async () => {
      // The masking above cannot be COMPLETE — `mastra_messages.id` is
      // free-form `TEXT` — so a thread wedged on an id the patterns do not
      // recognise still mints a fresh key every turn. The cap is the bound that
      // does not depend on the masking being complete.
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const wedged = 'compaction store read failed: connection terminated';

      expect(await failingTurn(runtime, wedged)).toBeDefined();
      expect(await failingTurn(runtime, wedged)).toBeUndefined();

      // A full cap's worth of DISTINCT keys must push out everything inserted
      // before them, whatever else this file has already latched — which makes
      // the assertion independent of test order. These variants also pin that
      // short digit runs stay distinct rather than masking into one key.
      for (let index = 0; index < MAX_TRACKED_COMPACTION_FAILURES; index += 1) {
        await failingTurn(runtime, `compaction store read failed: variant ${index}`);
      }

      // Drop-oldest, so the evicted failure reports ONE more time. A repeat row
      // is the safe direction; a permanent silence is not.
      expect(await failingTurn(runtime, wedged)).toBeDefined();
    });

    it('does not evict on a repeated commit of a key it already holds', async () => {
      // BST-1737 documents `markReported` as idempotent AND accepts that two
      // turns failing identically before either prelude is consumed both mint
      // and both commit. At the cap, a commit that adds nothing must also evict
      // nothing — otherwise that race quietly costs an UNRELATED thread its
      // latch, and the cap starts eating entries it was never asked to.
      const runtime = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const flush = (index: number) => `compaction flush variant ${index}`;

      // A full cap of distinct keys leaves the set holding exactly these, in
      // this order, whatever the rest of the file latched before us.
      for (let index = 0; index < MAX_TRACKED_COMPACTION_FAILURES; index += 1) {
        await failingTurn(runtime, flush(index));
      }

      // The documented race: both turns mint, because neither has delivered.
      const raced = { memory: { threadId: freshThreadId() } } as unknown as RuntimeData;
      const first = makeInput({ runtime: raced });
      (
        first.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('compaction raced'));
      const second = makeInput({ runtime: raced });
      (
        second.input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('compaction raced'));
      const one = await runConversationCompactionBeforeStream(first.input as never);
      const two = await runConversationCompactionBeforeStream(second.input as never);
      expect(one.failure).toBeDefined();
      expect(two.failure).toBeDefined();

      // The first commit evicts exactly one entry — the oldest. The second adds
      // nothing, so it must evict nothing.
      await deliverPrelude(one);
      await deliverPrelude(two);

      // Probe the SURVIVOR first: a suppressed probe never reaches
      // `markReported`, so it cannot disturb the set, whereas the re-minting
      // probe below delivers a row and evicts `flush(1)` on its way out.
      expect(await failingTurn(runtime, flush(1))).toBeUndefined();
      expect(await failingTurn(runtime, flush(0))).toBeDefined();
    });
  });

  it('mints no breadcrumb when the turn was cancelled mid-pass', async () => {
    // `run.cancelled` already reports a cancelled turn. A "compaction
    // unavailable" row here would be a false alarm on every cancellation that
    // lands inside the pass.
    const controller = new AbortController();
    const { input, logger } = makeInput({ signal: controller.signal });
    (input.capabilities.compaction.runPreRequest as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        controller.abort();
        return Promise.reject(new Error('The operation was aborted.'));
      }
    );

    const outcome = await runConversationCompactionBeforeStream(input as never);
    expect(outcome.failure).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('withCompactionPreludeChunks', () => {
  it('returns the source untouched when there is nothing to prepend', () => {
    const source = streamOf([]);
    expect(withCompactionPreludeChunks(source, {})).toBe(source);
    expect(withCompactionPreludeChunks(source, { result: { kind: 'noop' } })).toBe(source);
  });

  it('prepends exactly one child-run-usage chunk ahead of the real stream', async () => {
    const tail: StreamChunk[] = [{ type: 'text-delta', value: 'hello' } as unknown as StreamChunk];
    const usage = {
      estimated: true,
      inputTokens: 7,
      outputTokens: 2,
      source: 'om-observation' as const,
    };

    const observed = await collect(
      withCompactionPreludeChunks(streamOf(tail), { result: { kind: 'agentic', usage } })
    );

    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({ type: 'child-run-usage', value: usage });
    expect(observed[1]).toEqual(tail[0]);
  });

  it('carries the failure breadcrumb onto the FRONT of the turn the user reads (BST-1737)', async () => {
    // The breadcrumb rides the SAME prelude the usage chunk already rides, so
    // it reaches `observe()` (and therefore run-event persistence and the
    // timeline) through the ordinary run-event chunk path — no second seam.
    const tail: StreamChunk[] = [{ type: 'text-delta', value: 'hi' } as unknown as StreamChunk];
    const chunk = {
      event: { id: 'e', kind: 'compaction.failed', label: 'x', status: 'failed', timestamp: 't' },
      type: 'run-event',
    } as unknown as StreamChunk;
    const markReported = vi.fn();
    const outcome: PreRequestCompactionOutcome = { failure: { chunk, markReported } };

    const observed = await collect(withCompactionPreludeChunks(streamOf(tail), outcome));

    expect(observed).toHaveLength(2);
    expect(observed[0]).toBe(chunk);
    expect(observed[1]).toEqual(tail[0]);
    // Delivery is what commits the latch, and it commits exactly once.
    expect(markReported).toHaveBeenCalledTimes(1);
  });

  it('leaves the latch UNcommitted for a stream that is never consumed', async () => {
    // Constructing the wrapper must have no side effect at all: the generator
    // body does not run until something pulls from it.
    const markReported = vi.fn();
    const chunk = { type: 'run-event' } as unknown as StreamChunk;
    const wrapped = withCompactionPreludeChunks(streamOf([]), {
      failure: { chunk, markReported },
    });
    expect(markReported).not.toHaveBeenCalled();

    // A consumer that takes the row and walks away has not proved the row
    // survived the turn either, so the latch stays open for the next one.
    const iterator = wrapped[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: chunk });
    await iterator.return?.(undefined);
    expect(markReported).not.toHaveBeenCalled();
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
