import type { ModelMessage } from 'ai';
import type { HostPlatform, HostProjectionRewrite, HostToolInvocation } from './ports.js';
import type { HostEvent, HostLogRow } from './protocol.js';

type Rewritten = Extract<HostEvent, { type: 'tool.projection.rewritten' }>;

/** A call keeps its first committed rewrite, as the legacy rewrite table's primary key did. */
function foldRewrites(target: Map<string, HostProjectionRewrite>, event: Rewritten): void {
  for (const rewrite of event.rewrites) {
    if (!target.has(rewrite.toolCallId)) {
      target.set(rewrite.toolCallId, rewrite);
    }
  }
}

/** Every committed rewrite of the given rows, keyed by tool call. */
export function committedRewrites(rows: readonly HostLogRow[]): Map<string, HostProjectionRewrite> {
  const rewrites = new Map<string, HostProjectionRewrite>();
  for (const row of rows) {
    if (row.event.type === 'tool.projection.rewritten') {
      foldRewrites(rewrites, row.event);
    }
  }
  return rewrites;
}

/** Core-owned fold of committed rewrites per thread; the run log is the only record. */
export class HostProjectionRewrites {
  private readonly threads = new Map<string, Map<string, HostProjectionRewrite>>();

  fold(row: HostLogRow): void {
    if (row.event.type !== 'tool.projection.rewritten') {
      return;
    }
    const rewrites = this.threads.get(row.threadId) ?? new Map<string, HostProjectionRewrite>();
    foldRewrites(rewrites, row.event);
    this.threads.set(row.threadId, rewrites);
  }

  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  read(threadId: string): ReadonlyMap<string, HostProjectionRewrite> {
    return this.threads.get(threadId) ?? new Map();
  }
}

function parts(message: ModelMessage) {
  return typeof message.content === 'string' ? [] : message.content;
}

/** Calls with a committed result, in branch order, plus the current turn's call IDs. */
function branchInvocations(
  messages: readonly ModelMessage[],
  outputs: ReadonlyMap<string, unknown>
): {
  readonly currentTurnToolCallIds: Set<string>;
  readonly invocations: HostToolInvocation[];
} {
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const calls = new Map<string, { args: unknown; toolName: string }>();
  const invocations: HostToolInvocation[] = [];
  const currentTurnToolCallIds = new Set<string>();
  messages.forEach((message, index) => {
    for (const part of parts(message)) {
      if (part.type === 'tool-call') {
        calls.set(part.toolCallId, { args: part.input, toolName: part.toolName });
        if (index > lastUser) {
          currentTurnToolCallIds.add(part.toolCallId);
        }
      }
      const call = part.type === 'tool-result' ? calls.get(part.toolCallId) : undefined;
      if (part.type === 'tool-result' && call) {
        invocations.push({
          ...call,
          modelOutput: part.output,
          output: outputs.get(part.toolCallId),
          toolCallId: part.toolCallId,
        });
      }
    }
  });
  return { currentTurnToolCallIds, invocations };
}

/**
 * The legacy `rewriteToolProjectionPrompt` rule over SDK messages: a rewritten
 * result's output becomes its marker; a supersession applies only while its
 * superseding call is in the same messages.
 */
export function applyProjectionRewrites(
  messages: readonly ModelMessage[],
  rewrites: ReadonlyMap<string, HostProjectionRewrite>
): ModelMessage[] {
  if (rewrites.size === 0) {
    return [...messages];
  }
  const present = new Set(
    messages.flatMap((message) =>
      parts(message).flatMap((part) =>
        part.type === 'tool-call' || part.type === 'tool-result' ? [part.toolCallId] : []
      )
    )
  );
  return messages.map((message): ModelMessage => {
    if (message.role !== 'tool') {
      return message;
    }
    const content = message.content.map((part) => {
      const rewrite = part.type === 'tool-result' ? rewrites.get(part.toolCallId) : undefined;
      if (
        part.type !== 'tool-result' ||
        !rewrite ||
        (rewrite.kind === 'supersession' && !present.has(rewrite.supersededByToolCallId))
      ) {
        return part;
      }
      return { ...part, output: { type: 'text' as const, value: rewrite.markerText } };
    });
    return { ...message, content };
  });
}

/**
 * Before each provider request of a run: ask the platform's rewrite policy
 * about the branch's unrewritten calls, commit what it selects, and return
 * the messages with every committed rewrite applied.
 */
export async function prepareProjectionRewrites(input: {
  readonly commit: (event: Rewritten) => Promise<void>;
  readonly existing: ReadonlyMap<string, HostProjectionRewrite>;
  readonly messages: readonly ModelMessage[];
  /** Raw committed effect outputs of the branch's runs, by tool call. */
  readonly outputs: ReadonlyMap<string, unknown>;
  readonly runId: string;
  readonly select: HostPlatform['selectProjectionRewrites'];
}): Promise<ModelMessage[]> {
  const rewrites = new Map(input.existing);
  if (input.select) {
    const branch = branchInvocations(input.messages, input.outputs);
    const selected = input.select({
      currentTurnToolCallIds: branch.currentTurnToolCallIds,
      invocations: branch.invocations.filter(({ toolCallId }) => !rewrites.has(toolCallId)),
    });
    if (selected.length > 0) {
      const event: Rewritten = {
        rewrites: [...selected],
        runId: input.runId,
        type: 'tool.projection.rewritten',
      };
      await input.commit(event);
      foldRewrites(rewrites, event);
    }
  }
  return applyProjectionRewrites(input.messages, rewrites);
}
