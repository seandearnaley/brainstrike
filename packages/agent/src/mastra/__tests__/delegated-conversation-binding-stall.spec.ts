/**
 * The binding's end of a stalled BACKGROUND child (docs/agents/assistant-subagents.md,
 * "Background child deadlines"): a child's own watchdog ends that child's
 * EXECUTION with the stall — never its selected-Stop cancellation — and the
 * delegation hook rejects the executor with that stall, so the native task
 * fails as its own task instead of completing on the child's unwind.
 */
import type { DelegationStartContext } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { StreamStalledError } from '../../stream/with-inactivity-timeout';
import {
  BackgroundChildStalledError,
  describeChildExecutionEnd,
} from '../background-child-watchdog';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';

const target = { parentRuntimeRunId: 'root-run', parentToolCallId: 'call-t1' } as const;

function startContext(): DelegationStartContext {
  return {
    iteration: 1,
    messages: [],
    params: {},
    parentAgentId: 'root',
    parentAgentName: 'Root',
    primitiveId: 'explore',
    primitiveType: 'agent',
    prompt: 'Read evidence',
    requestContext: new RequestContext(),
    resourceId: 'owner',
    runId: target.parentRuntimeRunId,
    threadId: 'root-thread',
    toolCallId: target.parentToolCallId,
  };
}

const stall = () =>
  new BackgroundChildStalledError(
    new StreamStalledError(1000, { lastPartType: 'text-delta', partsSeen: 3, phase: 'streaming' })
  );

const afterToolCall = (
  binding: ReturnType<typeof createDelegatedConversationBinding>,
  error?: unknown
) =>
  binding.hooks?.afterToolCall?.({
    context: { threadId: 'root-thread', toolCallId: target.parentToolCallId },
    input: { prompt: 'Read evidence' },
    output: undefined,
    toolName: 'agent-explore',
    ...(error === undefined ? {} : { error }),
  });

/** What the hook threw, whether it threw synchronously or rejected. */
async function thrownBy(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return;
}

/**
 * Every entry the hook owns for one execution is gone: its stall end, its
 * prepared address, and any deadline staged at that address.
 */
function expectReleased(
  binding: ReturnType<typeof createDelegatedConversationBinding>,
  staged: AbortController
): void {
  // The stall end: nothing of that execution is left to end.
  expect(binding.endStalledExecution(target, stall())).toBe(false);
  // The prepared address: the hook has nothing more to release…
  expect(afterToolCall(binding)).toBeUndefined();
  // …and a new execution of the invocation may prepare there.
  expect(() => binding.prepare(startContext(), { persona: 'explore' })).not.toThrow();
  // The staged deadline: the new execution never inherits it.
  staged.abort(new Error('A stale deadline'));
  expect(binding.getExecutionAbortSignal?.(target)?.aborted).toBe(false);
}

describe('a stalled background child ends its own execution', () => {
  it('has nothing to end before the invocation is prepared', () => {
    const binding = createDelegatedConversationBinding(async () => {});
    expect(binding.endStalledExecution(target, stall())).toBe(false);
  });

  it('aborts the child and its execution with the stall, never its cancellation', () => {
    const binding = createDelegatedConversationBinding(async () => {});
    const context = startContext();
    binding.prepare(context, { persona: 'explore' });
    const reason = stall();
    expect(binding.endStalledExecution(target, reason)).toBe(true);
    expect(binding.getAbortSignal?.(context.requestContext)?.reason).toBe(reason);
    expect(binding.getExecutionAbortSignal?.(target)?.reason).toBe(reason);
    // A stall is a failure, not the user's selected Stop.
    expect(binding.getInvocationAbortSignal?.(target)?.aborted).toBe(false);
  });

  it('rejects the executor with the stall even when the unwinding child resolved', async () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    const reason = stall();
    binding.endStalledExecution(target, reason);
    expect(await thrownBy(() => afterToolCall(binding))).toBe(reason);
  });

  it('rejects the executor with the stall, not the abort the unwinding child threw', async () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    const reason = stall();
    binding.endStalledExecution(target, reason);
    const unwind = new DOMException('This operation was aborted', 'AbortError');
    expect(await thrownBy(() => afterToolCall(binding, unwind))).toBe(reason);
  });

  it('leaves an execution that was never stalled to its own outcome', async () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    expect(await thrownBy(() => afterToolCall(binding))).toBeUndefined();
  });

  it.each([
    { label: 'the unwinding child resolved', unwind: undefined },
    {
      label: 'the unwinding child threw its abort',
      unwind: new DOMException('This operation was aborted', 'AbortError'),
    },
  ])(
    'releases everything a stalled execution holds before its hook rejects ($label)',
    async ({ unwind }) => {
      const binding = createDelegatedConversationBinding(async () => {});
      binding.prepare(startContext(), { persona: 'explore' });
      // A deadline staged for the NEXT execution of this invocation.
      const staged = new AbortController();
      binding.captureExecutionAbortSignal?.(
        { ...target, parentThreadId: 'root-thread' },
        staged.signal
      );
      const reason = stall();
      binding.endStalledExecution(target, reason);
      expect(await thrownBy(() => afterToolCall(binding, unwind))).toBe(reason);
      expectReleased(binding, staged);
    }
  );

  it('releases everything an execution holds when it failed before its child streamed', async () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    const staged = new AbortController();
    binding.captureExecutionAbortSignal?.(
      { ...target, parentThreadId: 'root-thread' },
      staged.signal
    );
    expect(
      await thrownBy(() => afterToolCall(binding, new Error('Child admission failed')))
    ).toBeUndefined();
    expectReleased(binding, staged);
  });

  it('keeps the stall in an execution signal captured after preparation', () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    const native = new AbortController();
    binding.captureExecutionAbortSignal?.(
      { ...target, parentThreadId: 'root-thread' },
      native.signal
    );
    const reason = stall();
    binding.endStalledExecution(target, reason);
    const ended = binding.getExecutionAbortSignal?.(target);
    expect(ended?.reason).toBe(reason);
    // The child's terminal reads this signal: its detail and breadcrumb survive.
    expect(describeChildExecutionEnd(ended?.reason)).toEqual({
      detail: reason.message,
      metadata: {
        code: 'background_child_stalled',
        inactivityMs: 1000,
        lastPartType: 'text-delta',
        partsSeen: 3,
        phase: 'streaming',
      },
    });
  });

  it('still ends on a native deadline captured after preparation', () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    const native = new AbortController();
    binding.captureExecutionAbortSignal?.(
      { ...target, parentThreadId: 'root-thread' },
      native.signal
    );
    const deadline = new Error('Task timed out after 1000ms');
    native.abort(deadline);
    expect(binding.getExecutionAbortSignal?.(target)?.reason).toBe(deadline);
  });

  it('has nothing to end once the execution is over', async () => {
    const binding = createDelegatedConversationBinding(async () => {});
    binding.prepare(startContext(), { persona: 'explore' });
    await afterToolCall(binding);
    expect(binding.endStalledExecution(target, stall())).toBe(false);
  });
});
