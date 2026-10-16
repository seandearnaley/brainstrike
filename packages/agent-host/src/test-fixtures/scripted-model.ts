import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
// Recorded SDK tool-call/finish payload shape shared by the host and desktop tests,
// represented by the pinned provider v4 contract. Only the model is scripted.
export function scriptedModel(toolId?: string): MockLanguageModelV4 {
  return scriptedToolSequence(
    toolId ? [{ input: { text: 'written by permitted host tool' }, toolId }] : []
  );
}

export function scriptedToolSequence(
  calls: readonly { readonly toolId: string; readonly input: unknown }[],
  /** Every request, as the provider received it, when the test reads them. */
  prompts?: Parameters<MockLanguageModelV4['doStream']>[0]['prompt'][]
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts?.push(options.prompt);
      const latestUser = options.prompt.findLastIndex((message) => message.role === 'user');
      const completed = new Set(
        options.prompt
          .slice(latestUser)
          .flatMap((message) =>
            message.role === 'tool'
              ? message.content
                  .filter((part) => part.type === 'tool-result')
                  .map((part) => part.toolCallId)
              : []
          )
      );
      const step = calls.findIndex((_call, index) => !completed.has(`recorded-call-${index + 1}`));
      const call = calls[step];
      const chunks: Chunk[] = call
        ? [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify(call.input),
              toolCallId: `recorded-call-${step + 1}`,
              toolName: call.toolId,
              type: 'tool-call',
            },
            { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: 'Host run completed.', id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

export function parallelToolModel(toolId: string): MockLanguageModelV4 {
  const finished = scriptedModel();
  return new MockLanguageModelV4({
    doStream: async (options) => {
      if (
        options.prompt.some(
          (message) =>
            message.role === 'tool' && message.content.some((part) => part.type === 'tool-result')
        )
      ) {
        return finished.doStream(options);
      }
      const chunks: Chunk[] = [
        { type: 'stream-start', warnings: [] },
        ...[1, 2].map(
          (index): Chunk => ({
            input: JSON.stringify({ text: `owned-action-${index}` }),
            toolCallId: `parallel-call-${index}`,
            toolName: toolId,
            type: 'tool-call',
          })
        ),
        { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
      ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

type Prompt = Parameters<MockLanguageModelV4['doStream']>[0]['prompt'];

/** The latest result the model received for `toolCallId`. */
export function scriptedToolResult(prompt: Prompt, toolCallId: string): unknown {
  for (const message of [...prompt].reverse()) {
    if (message.role !== 'tool') {
      continue;
    }
    const part = message.content.find(
      (item) => item.type === 'tool-result' && item.toolCallId === toolCallId
    );
    if (part?.type === 'tool-result') {
      return part.output;
    }
  }
  return;
}

function continuation(
  output: unknown
): { readonly input: unknown; readonly tool: string } | undefined {
  const value =
    output && typeof output === 'object' && 'value' in output ? output.value : undefined;
  const next = value && typeof value === 'object' && 'next' in value ? value.next : undefined;
  return next &&
    typeof next === 'object' &&
    'tool' in next &&
    typeof next.tool === 'string' &&
    'input' in next
    ? { input: next.input, tool: next.tool }
    : undefined;
}

/**
 * Calls `toolId` once, then follows the continuation its result names (an
 * artifact page's `next` tool and input) once, then answers. Every request is
 * recorded in `prompts`, as the provider received it.
 */
export function scriptedCursorPaging(toolId: string, prompts: Prompt[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      const next =
        prompts.length === 2
          ? continuation(scriptedToolResult(options.prompt, 'paging-call-1'))
          : undefined;
      const call =
        prompts.length === 1
          ? { id: 'paging-call-1', input: {}, tool: toolId }
          : next && { id: 'paging-call-2', input: next.input, tool: next.tool };
      const chunks: Chunk[] = call
        ? [
            { type: 'stream-start', warnings: [] },
            {
              input: JSON.stringify(call.input),
              toolCallId: call.id,
              toolName: call.tool,
              type: 'tool-call',
            },
            { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: 'Paged.', id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ];
      return {
        stream: simulateReadableStream({ chunkDelayInMs: null, chunks, initialDelayInMs: null }),
      };
    },
  });
}

/** The wake ledger's heading: the parent model's input when its children report back. */
const WAKE_LEDGER = 'Background invocations of this turn';

/**
 * BST-1932: a delegating root and its children, told apart by the tools each
 * request offers. The root's first turn delegates once through `delegate`;
 * after a tool result or a wake ledger it answers. A child runs `childCalls`
 * in order, then answers.
 */
export function scriptedDelegation(
  delegate: { readonly toolId: string; readonly input: unknown },
  childCalls: readonly { readonly toolId: string; readonly input: unknown }[]
): MockLanguageModelV4 {
  const root = scriptedToolSequence([delegate]);
  const answered = scriptedToolSequence([]);
  const child = scriptedToolSequence(childCalls);
  return new MockLanguageModelV4({
    doStream: async (options) => {
      if (!(options.tools ?? []).some((tool) => tool.name === delegate.toolId)) {
        return child.doStream(options);
      }
      const delegated = options.prompt.some(
        (message) =>
          message.role === 'tool' ||
          (message.role === 'user' &&
            message.content.some((part) => part.type === 'text' && part.text.includes(WAKE_LEDGER)))
      );
      return (delegated ? answered : root).doStream(options);
    },
  });
}

/** A step held open until its run is aborted (a user's Stop). */
function heldStep(abortSignal: AbortSignal | undefined): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      if (abortSignal?.aborted) {
        controller.error(abortSignal.reason);
        return;
      }
      abortSignal?.addEventListener(
        'abort',
        () => controller.error(abortSignal.reason ?? new Error('aborted')),
        { once: true }
      );
    },
  });
}

/**
 * BST-1932: like {@link scriptedDelegation}, but each child runs `childCalls`
 * and then holds its next step open until it is stopped, so a test can watch
 * a background child still working after its parent's run has ended.
 */
export function scriptedHeldDelegation(
  delegate: { readonly toolId: string; readonly input: unknown },
  childCalls: readonly { readonly toolId: string; readonly input: unknown }[]
): MockLanguageModelV4 {
  const parent = scriptedDelegation(delegate, []);
  const child = scriptedToolSequence(childCalls);
  return new MockLanguageModelV4({
    doStream: async (options) => {
      if ((options.tools ?? []).some((tool) => tool.name === delegate.toolId)) {
        return parent.doStream(options);
      }
      const latestUser = options.prompt.findLastIndex((message) => message.role === 'user');
      const results = options.prompt
        .slice(latestUser)
        .filter((message) => message.role === 'tool').length;
      return results < childCalls.length
        ? child.doStream(options)
        : { stream: heldStep(options.abortSignal) };
    },
  });
}

/** Streams a partial answer, then holds its step open until the run is aborted (a user's Stop). */
export function scriptedPartialThenHeld(partial: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<Chunk>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ id: 'text-1', type: 'text-start' });
          controller.enqueue({ delta: partial, id: 'text-1', type: 'text-delta' });
          abortSignal?.addEventListener(
            'abort',
            () => controller.error(abortSignal.reason ?? new Error('aborted')),
            { once: true }
          );
        },
      }),
    }),
  });
}
