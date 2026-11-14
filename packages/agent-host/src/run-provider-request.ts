/**
 * A run's provider request boundary (BST-1927): the request middleware that
 * filters, measures and limits each prompt, given the provenance and committed
 * rewrites of the step it sends, and the receipt of every prepared request.
 */
import {
  createProviderRequestMiddleware,
  type ProviderRequestAccounting,
  type ProviderRequestContext,
  preparedPromptBreakdown,
  preparedPromptToolCalls,
} from '@brainstrike/agent/provider-request';
import {
  type AssistantContextBreakdown,
  applyPromptToolCallWindow,
  diffPromptToolCallWindow,
  type PromptToolCall,
  type PromptToolCallWindow,
} from '@brainstrike/assistant-contract/context-breakdown';
import type { MastraDBMessage } from '@mastra/core/agent';
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import type { HostProjectionRewrite } from './ports.ts';
import type { HostEvent } from './protocol.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/** One prepared request, as Core commits it (`provider.request.prepared`). */
export interface HostProviderRequestReceipt {
  readonly accounting: ProviderRequestAccounting;
  readonly breakdown: AssistantContextBreakdown;
  readonly modelId: string;
  readonly provider: string;
  readonly toolCallWindow: PromptToolCallWindow;
  /** BST-2531: what the request's trim left out, committed with it as a compaction. */
  readonly trim?: Compacted;
}

/** One run's provider requests: each step prepares what its request sends before the call. */
export class HostProviderRequest {
  /** The provenance of the step's request (`hostProviderHistory`); none before the first step prepares. */
  private history: readonly MastraDBMessage[] | undefined;
  /** Committed tool-output rewrites as of the step's history read. */
  private rewrites: ReadonlyMap<string, HostProjectionRewrite> = new Map();
  /**
   * How the step's context names what a trim left out (`HostCompactedContext.trim`);
   * the step's first trimmed request takes it.
   */
  private trim: ((kept: number) => Compacted | undefined) | undefined;
  /** The tool calls this run's previous provider request carried; none before its first. */
  private previousRequestToolCalls: ReadonlyMap<string, PromptToolCall> | undefined;

  private readonly selected: ProviderRequestContext;
  private readonly record: (receipt: HostProviderRequestReceipt) => Promise<void>;

  constructor(
    selected: ProviderRequestContext,
    record: (receipt: HostProviderRequestReceipt) => Promise<void>
  ) {
    this.selected = selected;
    this.record = record;
  }

  /** What the step's requests send, read from the committed log, and how to name a trim of it. */
  prepare(
    history: readonly MastraDBMessage[],
    rewrites: ReadonlyMap<string, HostProjectionRewrite>,
    trim: (kept: number) => Compacted | undefined
  ): void {
    this.history = history;
    this.rewrites = rewrites;
    this.trim = trim;
  }

  /** Enclose the selected concrete model at its final public provider boundary. */
  wrap(model: LanguageModel): LanguageModel {
    if (typeof model === 'string') {
      throw new Error('Host provider preparation requires the selected concrete model');
    }
    const { selected } = this;
    const middleware = createProviderRequestMiddleware({
      context: async () => {
        const { history } = this;
        if (history === undefined) {
          throw new Error('Provider request requires its prepared history');
        }
        return { ...selected, history, rewrites: this.rewrites };
      },
      onPrepared: async (prepared) => {
        const toolCalls = preparedPromptToolCalls(prepared);
        const toolCallWindow = diffPromptToolCallWindow(this.previousRequestToolCalls, toolCalls);
        // A step's SDK retries send the same request again: its trim is named
        // once, by the first attempt that trims, and never committed twice.
        const name = prepared.accounting.removedMessages > 0 ? this.trim : undefined;
        if (name) {
          this.trim = undefined;
        }
        // A trimmed request starts at a user message: it kept that one and every later one.
        const trim = name?.(prepared.params.prompt.filter(({ role }) => role === 'user').length);
        await this.record({
          accounting: prepared.accounting,
          breakdown: preparedPromptBreakdown(prepared, toolCalls),
          modelId: model.modelId,
          provider: selected.provider,
          toolCallWindow,
          ...(trim ? { trim } : {}),
        });
        // Only a committed receipt becomes the next window's base.
        this.previousRequestToolCalls = applyPromptToolCallWindow(
          this.previousRequestToolCalls,
          toolCallWindow
        );
      },
    });
    return wrapLanguageModel({
      // Both pins implement the public V4 primitive. The older provider's
      // declaration omits readonly JSON, while the installed SDK permits it.
      // Keep this DTO type bridge here; adding ai 7 to the legacy agent package
      // would change its separate Mastra/ai 6 peer closure. Joined tests compare
      // the prepared public params to the actual SDK model call without copies.
      // https://github.com/vercel/ai/tree/main/packages/provider
      // Remove this type bridge when both existing declaration pins agree.
      middleware: middleware as unknown as LanguageModelMiddleware,
      model,
    });
  }
}
