import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import type { ScopedLogger } from '@brainstrike/logging';
import { type DelegationStartContext, type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
import { DelegatedWorkQueue } from '../delegated-work-budget';
import {
  createDelegationConfig,
  createDelegationLifecycleTracker,
  createDelegationOutcomeCapture,
  MAX_CONCURRENT_DELEGATIONS,
  MAX_DELEGATIONS_PER_RUN,
  shouldEnablePersonas,
} from '../subagent-delegation';

const silentLogger: ScopedLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
} as unknown as ScopedLogger;

const persona: AssistantPersonaDefinition = {
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'Explore',
  id: 'explore',
  instructions: 'Explore.',
  label: 'Explorer',
  maxSteps: 8,
};

const personasById = new Map([['explore', persona]]);

let nextCall = 0;
/** Each start is its own native invocation unless a test names the address. */
function startContext(overrides: Partial<DelegationStartContext> = {}): DelegationStartContext {
  nextCall += 1;
  return {
    iteration: 1,
    messages: [],
    params: {},
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent',
    prompt: 'find the flag',
    requestContext: new RequestContext(),
    runId: 'run-1',
    toolCallId: `call-${nextCall}`,
    ...overrides,
  };
}

function completeContext(overrides: Record<string, unknown> = {}) {
  return {
    bail: () => undefined,
    duration: 10,
    iteration: 1,
    messages: [],
    parentAgentId: 'parent',
    parentAgentName: 'Parent',
    primitiveId: 'explore',
    primitiveType: 'agent' as const,
    prompt: 'find the flag',
    result: { text: 'done' },
    runId: 'run-1',
    success: true,
    toolCallId: 'call-1',
    ...overrides,
  };
}

describe('createDelegationConfig', () => {
  it('proceeds for a known persona and clamps a model-supplied maxSteps to the cap', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const result = await config.onDelegationStart?.(startContext({ params: { maxSteps: 50 } }));
    expect(result).toEqual({
      modifiedInstructions: '',
      modifiedMaxSteps: 8,
      modifiedPrompt: 'find the flag',
      proceed: true,
    });
  });

  it('defaults modifiedMaxSteps to the persona cap when the model requests none', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const result = await config.onDelegationStart?.(startContext());
    expect(result).toEqual({
      modifiedInstructions: '',
      modifiedMaxSteps: 8,
      modifiedPrompt: 'find the flag',
      proceed: true,
    });
  });

  it('rejects a delegation to an unknown persona (no silent fallback)', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const result = await config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(result).toMatchObject({ proceed: false });
  });

  it('rejects the 3rd concurrent start while 2 are in flight', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(MAX_CONCURRENT_DELEGATIONS).toBe(2);
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it.each([false, true])(
    'uses runnable admission only with both a durable budget and its queue: %s',
    async (withQueue) => {
      const config = createDelegationConfig({
        abortSignal: new AbortController().signal,
        logger: silentLogger,
        personasById,
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        ...(withQueue ? { workQueue: new DelegatedWorkQueue() } : {}),
        conversationBinding: {
          ...createDelegatedConversationBinding(async () => undefined),
          budget: {
            admitInvocation: async () => ({ admitted: true as const }),
            reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
            settleStep: async () => undefined,
          },
        },
      });
      for (const toolCallId of ['a', 'b']) {
        expect(
          await config.onDelegationStart?.(
            startContext({ resourceId: 'owner', threadId: 'root', toolCallId })
          )
        ).toMatchObject({ proceed: true });
      }
      expect(
        await config.onDelegationStart?.(
          startContext({ resourceId: 'owner', threadId: 'root', toolCallId: 'c' })
        )
      ).toMatchObject({ proceed: withQueue });
    }
  );

  it('asks the durable budget at start and rejects with the host reason (BST-1751)', async () => {
    const outcomes = createDelegationOutcomeCapture();
    const calls: { parentThreadId: string; parentResourceId: string }[] = [];
    const reason = 'Delegation invocation limit reached (8 per original turn).';
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        budget: {
          admitInvocation: async (scope) => {
            calls.push(scope);
            return calls.length === 1
              ? { admitted: true as const }
              : { admitted: false as const, reason };
          },
          reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
          settleStep: async () => undefined,
        },
      },
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      workQueue: new DelegatedWorkQueue(),
    });
    const admitted = await config.onDelegationStart?.(
      startContext({ resourceId: 'owner', threadId: 'root', toolCallId: 'a' })
    );
    expect(admitted).toMatchObject({ proceed: true });
    const refused = await config.onDelegationStart?.(
      startContext({ resourceId: 'owner', threadId: 'root', toolCallId: 'b' })
    );
    expect(refused).toEqual({ proceed: false, rejectionReason: reason });
    expect(calls).toEqual([
      { parentResourceId: 'owner', parentThreadId: 'root' },
      { parentResourceId: 'owner', parentThreadId: 'root' },
    ]);
    // The refusal is recorded for the stream mapper; the admitted call is not.
    expect(outcomes.rejected('b', 'run-1')).toBe(true);
    expect(outcomes.rejected('a', 'run-1')).toBe(false);
  });

  it('turns a host identity refusal at start into a rejection, and propagates any other failure', async () => {
    const outcomes = createDelegationOutcomeCapture();
    let failure: Error = Object.assign(new Error('identity conflict'), {
      name: 'DelegatedConversationIdentityError',
      reason: 'parent-scope-mismatch',
    });
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        budget: {
          admitInvocation: async () => {
            throw failure;
          },
          reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
          settleStep: async () => undefined,
        },
      },
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      workQueue: new DelegatedWorkQueue(),
    });
    const refused = await config.onDelegationStart?.(
      startContext({ resourceId: 'owner', threadId: 'root', toolCallId: 'identity' })
    );
    expect(refused).toEqual({
      proceed: false,
      rejectionReason: 'Delegation admission refused (parent-scope-mismatch).',
    });
    expect(outcomes.rejected('identity', 'run-1')).toBe(true);
    failure = new Error('database unavailable');
    await expect(
      config.onDelegationStart?.(
        startContext({ resourceId: 'owner', threadId: 'root', toolCallId: 'fault' })
      )
    ).rejects.toThrow('database unavailable');
    expect(outcomes.rejected('fault', 'run-1')).toBe(false);
  });

  it('reserves the per-turn count before awaiting the host and releases it on refusal', async () => {
    // The hook awaits the durable budget, so parallel starts interleave. The
    // in-memory caps must be taken BEFORE that await and given back only when
    // the start is refused, or eight concurrent siblings plus a ninth could
    // all pass the check on the same stale count.
    let releaseAdmission: (
      admission: { admitted: true } | { admitted: false; reason: string }
    ) => void = () => undefined;
    const pending = new Promise<{ admitted: true } | { admitted: false; reason: string }>(
      (resolve) => {
        releaseAdmission = resolve;
      }
    );
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        budget: {
          admitInvocation: () => pending,
          reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
          settleStep: async () => undefined,
        },
      },
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      workQueue: new DelegatedWorkQueue(),
    });
    const start = (toolCallId: string) =>
      config.onDelegationStart?.(
        startContext({ resourceId: 'owner', threadId: 'root', toolCallId })
      );
    const inFlight = Array.from({ length: MAX_DELEGATIONS_PER_RUN }, (_, index) =>
      start(`sibling-${index}`)
    );
    // The ninth arrives while the first eight still await the host.
    const ninth = start('ninth');
    releaseAdmission({ admitted: false, reason: 'host said no' });
    const results = await Promise.all(inFlight);
    expect(results.every((result) => result?.proceed === false)).toBe(true);
    expect(await ninth).toMatchObject({
      proceed: false,
      rejectionReason: expect.stringMatching(/delegation limit/i),
    });
    // Every refusal gave its count back: a later start passes the cap and
    // reaches the host again (which still refuses, but on its own grounds).
    expect(await start('after-refusals')).toEqual({
      proceed: false,
      rejectionReason: 'host said no',
    });
  });

  it('records the in-memory backstop refusals as rejections too', async () => {
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    await config.onDelegationStart?.(startContext({ primitiveId: 'ghost', toolCallId: 'ghost' }));
    expect(outcomes.rejected('ghost', 'run-1')).toBe(true);
  });

  it('refuses to consult the durable budget without the parent thread identity', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        budget: {
          admitInvocation: async () => ({ admitted: true as const }),
          reserveStep: async () => ({ id: 'unused', outputTokens: 8192, synthesis: false }),
          settleStep: async () => undefined,
        },
      },
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      workQueue: new DelegatedWorkQueue(),
    });
    await expect(config.onDelegationStart?.(startContext())).rejects.toThrow(/parent thread/i);
  });

  it('a completed delegation frees a concurrency slot', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    await config.onDelegationStart?.(startContext());
    await config.onDelegationStart?.(startContext());
    config.onDelegationComplete?.(completeContext());
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
  });

  it('a parked child resumed inside the same leg takes no new slot and counts once', async () => {
    // A live decision resumes a parked child under its ORIGINAL native address
    // (same runId/toolCallId) in the running leg: the same invocation
    // continues on the slot it already holds. Counting it again rejected the
    // resume with "Too many concurrent subagents" while a sibling still ran.
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-1' }))).toMatchObject({
      proceed: true,
    });
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-2' }))).toMatchObject({
      proceed: true,
    });
    // Both slots taken; the resume of call-1 still proceeds, a new call does not.
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-1' }))).toMatchObject({
      proceed: true,
    });
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-3' }))).toMatchObject({
      proceed: false,
    });
    // The resumed child's completion frees exactly its one slot.
    config.onDelegationComplete?.(completeContext({ toolCallId: 'call-1' }));
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-3' }))).toMatchObject({
      proceed: true,
    });
    expect(await config.onDelegationStart?.(startContext({ toolCallId: 'call-4' }))).toMatchObject({
      proceed: false,
    });
  });

  it('a rejected start does NOT consume a slot', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    // Unknown persona rejected — must not increment inFlight.
    await config.onDelegationStart?.(startContext({ primitiveId: 'ghost' }));
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
    // Now 2 in flight; the 3rd is rejected by concurrency, proving the earlier
    // ghost rejection consumed nothing.
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });

  it('enforces the per-run total cap across completed delegations', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    for (let index = 0; index < MAX_DELEGATIONS_PER_RUN; index += 1) {
      expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
      config.onDelegationComplete?.(completeContext());
    }
    // The (MAX+1)th start is rejected even though nothing is in flight.
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: false });
  });
});

describe('createDelegationConfig: a child that returned no answer', () => {
  // BST-1410. Both delegations in run-7eb0e370 used exactly 8 step clusters
  // (the explore persona's cap) and returned `text: ""` with `success: true`.
  // The supervisor read that as a successful-but-empty delegation and abandoned
  // delegation for the rest of the turn. Mastra's own `resultText` docs name
  // this exact case as what the seam exists for.

  it('replaces an empty result with an explicit reason naming the tool-call count', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: {
          subAgentToolResults: Array.from({ length: 30 }, (_unused, index) => ({
            toolCallId: `child-${index}`,
            toolName: 'brainstrike.grepSearch',
          })),
          text: '',
        },
      })
    );

    expect(result).toMatchObject({
      resultText: expect.stringContaining('30 tool call'),
    });
    // The step cap is context the supervisor needs to re-scope its next
    // delegation; it is NOT asserted as the proven cause, because the hook
    // never sees a finishReason.
    expect((result as { resultText: string }).resultText).toContain('8');
    expect((result as { resultText: string }).resultText).not.toContain('undefined');
  });

  it('distinguishes a child that did nothing at all from one that ran out of steps', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: '   ' } })
    );

    expect(result).toMatchObject({ resultText: expect.stringContaining('no tool calls') });
  });

  it('leaves a real answer untouched', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: 'Found it.' },
      })
    );

    expect(result).toBeUndefined();
  });

  it('records the under-delivering delegation so the timeline can show it', async () => {
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    await config.onDelegationComplete?.(
      completeContext({ result: { text: '' }, toolCallId: 'call-empty' })
    );
    config.onDelegationStart?.(startContext());
    await config.onDelegationComplete?.(
      completeContext({ result: { text: 'Found it.' }, toolCallId: 'call-answered' })
    );

    expect(outcomes.returnedNoAnswer('call-empty', 'run-1')).toBe(true);
    expect(outcomes.returnedNoAnswer('call-answered', 'run-1')).toBe(false);
  });

  it('reports FAILED delegation without diagnosing a step cap', async () => {
    // The hook fires for failures too, and a child that threw plausibly arrives
    // with empty text. Handing it the step-cap narrative would be a confident,
    // wrong diagnosis of a provider error.
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      delegationOutcomes: outcomes,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({
        error: new Error('provider exploded'),
        result: { subAgentToolResults: [{ toolCallId: 'c1' }], text: '' },
        success: false,
        toolCallId: 'call-failed',
      })
    );

    expect(result).toMatchObject({
      resultText: expect.stringContaining('failed before completing'),
    });
    expect(outcomes.failed('call-failed', 'run-1')).toBe(true);
    expect(outcomes.failed('call-failed', 'another-parent')).toBe(false);
    expect(outcomes.returnedNoAnswer('call-failed', 'run-1')).toBe(false);
  });

  it('survives a delegation result whose text is not a string', async () => {
    // The exported type says `string`, but the path most likely to carry an
    // unexpected shape is the one that just went wrong.
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(
      completeContext({ result: { subAgentToolResults: [], text: undefined } })
    );

    expect(result).toMatchObject({ resultText: expect.stringContaining('no tool calls') });
  });

  it('says the tool activity is UNKNOWN rather than claiming there was none', async () => {
    // Absence is legitimate — core's v1/legacy delegation path returns `{ text }`
    // with no `subAgentToolResults` — so this must read as a reportable unknown,
    // never as "the child did nothing", which would steer the supervisor to redo
    // work that may already be done.
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    config.onDelegationStart?.(startContext());
    const result = await config.onDelegationComplete?.(completeContext({ result: { text: '' } }));

    expect(result).toMatchObject({
      resultText: expect.stringContaining('tool activity could not be determined'),
    });
    expect((result as { resultText: string }).resultText).not.toContain('made no tool calls');
  });

  it('still frees the concurrency slot for an empty delegation', async () => {
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    await config.onDelegationStart?.(startContext());
    await config.onDelegationStart?.(startContext());
    config.onDelegationComplete?.(completeContext({ result: { text: '' } }));
    expect(await config.onDelegationStart?.(startContext())).toMatchObject({ proceed: true });
  });
});

describe('createDelegationLifecycleTracker', () => {
  it('drains the metadata of a started-but-never-settled delegation (abort orphan)', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    tracker.started('delegation-2', { personaId: 'analyze', toolName: 'agent-analyze' });
    // delegation-2 reached a terminal event; only delegation-1 is orphaned.
    tracker.settled('delegation-2');

    const orphans = tracker.drainInFlight();
    expect(orphans).toEqual([{ personaId: 'explore', toolName: 'agent-explore' }]);
  });

  it('drains nothing when every started delegation settled', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    tracker.settled('delegation-1');
    expect(tracker.drainInFlight()).toEqual([]);
  });

  it('drains each in-flight delegation exactly once', () => {
    const tracker = createDelegationLifecycleTracker();
    tracker.started('delegation-1', { personaId: 'explore', toolName: 'agent-explore' });
    expect(tracker.drainInFlight()).toHaveLength(1);
    // A second drain (e.g. the finally block after the abort branch) yields nothing.
    expect(tracker.drainInFlight()).toEqual([]);
  });
});

describe('shouldEnablePersonas', () => {
  it('is false for the local provider even with personas', () => {
    expect(shouldEnablePersonas('local', [persona])).toBe(false);
  });

  it('is false when there are no personas', () => {
    expect(shouldEnablePersonas('openai', [])).toBe(false);
    expect(shouldEnablePersonas('openai', undefined)).toBe(false);
  });

  it('is true for a hosted provider with personas', () => {
    expect(shouldEnablePersonas('openai', [persona])).toBe(true);
  });
});

describe('delegated instruction and context authority', () => {
  const config = () =>
    createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: silentLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
  it('keeps model-authored instructions in the user task instead of system authority', async () => {
    const result = await config().onDelegationStart?.(
      startContext({ params: { instructions: 'Untrusted delegated detail' } })
    );
    expect(result).toMatchObject({
      modifiedInstructions: '',
      modifiedPrompt: 'find the flag\n\nDelegated task details:\nUntrusted delegated detail',
    });
  });
  it('bounds specialist references while retaining source roles, content and chronology', async () => {
    const list = new MessageList();
    list.add(
      [
        ...Array.from({ length: 20 }, (_, index) => ({
          content: `Document excerpt ${index}`,
          role: 'user' as const,
        })),
        { content: '☃'.repeat(30_000), role: 'user' },
      ],
      'input'
    );
    const trusted: MastraDBMessage = {
      content: {
        format: 2,
        metadata: { source: 'workspace-instructions' },
        parts: [{ text: 'Trusted workspace convention', type: 'text' }],
      },
      createdAt: new Date(0),
      id: 'trusted',
      role: 'system',
    };
    const messages = [trusted, ...list.get.all.db()];
    const before = JSON.stringify(messages);
    const invocation = startContext();
    const filtered = await config().messageFilter?.({ ...invocation, messages });
    expect(filtered?.map((message) => message.id)).toEqual([
      trusted.id,
      ...messages
        .slice(5, 21)
        .map((message) => `parent-reference:${invocation.toolCallId}:${message.id}`),
    ]);
    expect(filtered?.[0]).toEqual(trusted);
    for (const [index, reference] of (filtered?.slice(1) ?? []).entries()) {
      const part = reference.content.parts[0];
      if (part?.type !== 'text') {
        throw new Error('Missing parent reference');
      }
      expect(part.text).toContain('Parent conversation reference');
      expect(JSON.parse(part.text.slice(part.text.indexOf('\n') + 1))).toEqual({
        content: messages[index + 5]?.content,
        role: messages[index + 5]?.role,
      });
    }
    expect(filtered?.[0]?.role).toBe('system');
    expect(filtered?.slice(1).every((message) => message.role === 'user')).toBe(true);
    expect(JSON.stringify(messages)).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(filtered), 'utf8')).toBeLessThan(65_536);
  });
  it('preserves native image parts without reusing the parent message identity', async () => {
    const list = new MessageList();
    list.add(
      [
        {
          content: [
            { text: 'Inspect this screenshot.', type: 'text' },
            { image: 'data:image/png;base64,aGVsbG8=', type: 'image' },
          ],
          role: 'user',
        },
      ],
      'input'
    );
    const messages = list.get.all.db();
    const original = messages[0];
    const image = original?.content.parts.find((part) => part.type === 'file');
    expect(image).toBeDefined();
    const filtered = await config().messageFilter?.({ ...startContext(), messages });
    expect(filtered?.[0]?.id).not.toBe(original?.id);
    expect(filtered?.[0]?.threadId).toBeUndefined();
    expect(filtered?.[0]?.resourceId).toBeUndefined();
    expect(filtered?.[0]?.content.parts).toContainEqual(image);
  });
  it('fails closed instead of truncating oversized trusted instructions', async () => {
    const trusted: MastraDBMessage = {
      content: { format: 2, parts: [{ text: '☃'.repeat(30_000), type: 'text' }] },
      createdAt: new Date(0),
      id: 'trusted',
      role: 'system',
    };
    const filter = config().messageFilter;
    expect(() => filter?.({ ...startContext(), messages: [trusted] })).toThrow(
      'Trusted delegated context exceeds'
    );
  });
});

describe('child prompt manifests', () => {
  const builtFacts = {
    byPersonaId: new Map([
      [
        'explore',
        {
          instructions: 'Explore.\n\nAvailable tools: brainstrike.grepSearch.',
          toolNames: ['brainstrike.grepSearch'],
        },
      ],
    ]),
    dispatchingAgentId: 'parent',
  };

  function recordingConfig() {
    const records: unknown[] = [];
    const warnings: unknown[][] = [];
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      childPromptFacts: builtFacts,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        // The native `afterToolCall` hook releases a prepared address; a start
        // hook re-entered without it (a resume) must not trip the binding here.
        prepare: () => undefined,
        recordPromptManifest: async (record) => {
          records.push(record);
        },
      },
      logger: {
        ...silentLogger,
        warn: (...args: unknown[]) => {
          warnings.push(args);
        },
      } as unknown as ScopedLogger,
      personasById,
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    return { config, records, warnings };
  }

  it('records what the child is told: the prompt it receives, its built instructions and kept tools', async () => {
    const { config, records } = recordingConfig();
    const result = await config.onDelegationStart?.(
      startContext({
        params: { instructions: 'Start with src/' },
        prompt: 'Survey the repo',
        resourceId: 'owner',
        runId: 'root-run',
        threadId: 'root',
        toolCallId: 'call-survey',
      })
    );
    expect(result).toMatchObject({ proceed: true });
    // MUTATION: recording `context.prompt` drops the delegated task details the
    // child actually receives in its user prompt.
    expect(records).toEqual([
      {
        delegationPrompt: 'Survey the repo\n\nDelegated task details:\nStart with src/',
        kind: 'child-first-step',
        nativeRunId: 'root-run',
        parentToolCallId: 'call-survey',
        personaId: 'explore',
        personaInstructions: 'Explore.\n\nAvailable tools: brainstrike.grepSearch.',
        systemContextSource: 'root-leg',
        systemMessages: [],
        threadId: 'root',
        toolNames: ['brainstrike.grepSearch'],
      },
    ]);
    // A parked child resumed inside the leg re-enters the hook at the same
    // address. MUTATION: recording resumed addresses adds a second
    // child-first-step row for a first step that already happened.
    expect(
      await config.onDelegationStart?.(
        startContext({
          prompt: 'Survey the repo',
          resourceId: 'owner',
          runId: 'root-run',
          threadId: 'root',
          toolCallId: 'call-survey',
        })
      )
    ).toMatchObject({ proceed: true });
    expect(records).toHaveLength(1);
  });

  it('records nothing and says so when the facts describe another agent build (a nested delegation)', async () => {
    const { config, records, warnings } = recordingConfig();
    const result = await config.onDelegationStart?.(
      startContext({
        parentAgentId: 'worker',
        resourceId: 'owner',
        runId: 'child-run',
        threadId: 'child',
        toolCallId: 'call-nested',
      })
    );
    expect(result).toMatchObject({ proceed: true });
    // MUTATION: looking the persona up without the dispatching agent records
    // the ROOT build's tools and instructions for a grandchild built from a
    // narrower tool map.
    expect(records).toEqual([]);
    expect(warnings).toEqual([
      [
        'Child prompt manifest not recorded: no build facts describe this delegation',
        expect.objectContaining({
          code: 'subagent_prompt_manifest_unrecorded',
          parentAgentId: 'worker',
          personaId: 'explore',
          toolCallId: 'call-nested',
        }),
      ],
    ]);
  });
});

describe('native delegation deadline ownership', () => {
  it('aborts admitted child work on its execution deadline without granting selected Stop authority', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    const context = startContext({ resourceId: 'owner', threadId: 'root' });
    const identity = {
      parentRuntimeRunId: context.runId,
      parentThreadId: 'root',
      parentToolCallId: context.toolCallId,
    };
    const deadline = new AbortController();
    binding.captureExecutionAbortSignal?.(identity, deadline.signal);
    binding.prepare(context, { maxSteps: 8, persona });
    const reason = new Error('Task timed out');
    deadline.abort(reason);
    expect(binding.getAbortSignal?.(context.requestContext)?.reason).toBe(reason);
    expect(binding.getInvocationAbortSignal?.(identity)?.aborted).toBe(false);
  });

  it('preserves the active execution deadline when duplicate preparation is rejected', () => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    const context = startContext({ resourceId: 'owner', threadId: 'root' });
    binding.prepare(context, { maxSteps: 8, persona });
    const identity = {
      parentRuntimeRunId: context.runId,
      parentThreadId: 'root',
      parentToolCallId: context.toolCallId,
    };
    const deadline = new AbortController();
    binding.captureExecutionAbortSignal?.(identity, deadline.signal);
    const duplicate = startContext({
      resourceId: 'owner',
      threadId: 'root',
      toolCallId: context.toolCallId,
    });
    expect(() => binding.prepare(duplicate, { maxSteps: 8, persona })).toThrow(
      'Delegated cancellation already owns this native invocation.'
    );
    // The active execution still ends on its own deadline.
    const preserved = binding.getExecutionAbortSignal?.(identity);
    const reason = new Error('Task timed out after 1000ms');
    deadline.abort(reason);
    expect(preserved?.reason).toBe(reason);
  });

  it.each([false, true])(
    'settles an expired execution without overwriting an existing error (%s)',
    (hasError) => {
      const binding = createDelegatedConversationBinding(async () => undefined);
      const context = startContext({ resourceId: 'owner', threadId: 'root' });
      binding.prepare(context, { maxSteps: 8, persona });
      const identity = {
        parentRuntimeRunId: context.runId,
        parentThreadId: 'root',
        parentToolCallId: context.toolCallId,
      };
      const deadline = new AbortController();
      binding.captureExecutionAbortSignal?.(identity, deadline.signal);
      const reason = new Error('Task timed out after 1000ms');
      deadline.abort(reason);
      const finish = () =>
        binding.hooks?.afterToolCall?.({
          context: { threadId: 'root', toolCallId: context.toolCallId },
          input: {},
          toolName: 'agent-explore',
          ...(hasError ? { error: new Error('Original executor failure') } : {}),
        });
      if (hasError) {
        expect(finish).not.toThrow();
      } else {
        expect(finish).toThrow(reason);
      }
      expect(binding.getExecutionAbortSignal?.(identity)?.reason).toBe(reason);
      expect(binding.getInvocationAbortSignal?.(identity)?.aborted).toBe(false);
      // A new execution at the released address replaces the expired signal.
      const resumed = startContext({
        resourceId: 'owner',
        threadId: 'root',
        toolCallId: context.toolCallId,
      });
      binding.prepare(resumed, { maxSteps: 8, persona });
      // Only the new execution's own end (its child's stall) remains.
      expect(binding.getExecutionAbortSignal?.(identity)?.aborted).toBe(false);
      const resumedDeadlineOwner = new AbortController();
      binding.captureExecutionAbortSignal?.(identity, resumedDeadlineOwner.signal);
      // Composed with the new execution's own stall end, so it follows the deadline.
      const composed = binding.getExecutionAbortSignal?.(identity);
      expect(composed?.aborted).toBe(false);
      const resumedDeadline = new Error('Task timed out after 2000ms');
      resumedDeadlineOwner.abort(resumedDeadline);
      expect(composed?.reason).toBe(resumedDeadline);
      binding.captureExecutionAbortSignal?.(identity, undefined);
      // No deadline any more: only the execution's stall end remains.
      expect(binding.getExecutionAbortSignal?.(identity)?.aborted).toBe(false);
      expect(() =>
        binding.hooks?.afterToolCall?.({
          context: { threadId: 'root', toolCallId: context.toolCallId },
          input: {},
          toolName: 'agent-explore',
        })
      ).not.toThrow();
    }
  );
});
