/**
 * BST-2532: a compaction's summary, asked of the run's own model on the
 * run's own next request (its instructions, its tool definitions and tool
 * choice, its messages, through its provider request boundary), with one
 * host message after it that asks for the summary. The request shares the
 * run's cached prefix, so the call reads it instead of paying for the whole
 * history again.
 *
 * The tools stay exactly as the run sends them: Anthropic invalidates the
 * cached messages when `tool_choice` changes and everything when a tool
 * definition does (platform.claude.com/docs, "Prompt caching"). They go
 * without their executors, so a tool call comes back as data, and an answer
 * that calls a tool is a failed summary, never a run of the tool.
 */
import {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from '@brainstrike/agent/provider-runtime';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import { generateText, type LanguageModel, type ToolSet } from 'ai';
import { hostNotice } from './child-delivery.ts';
import { type Json, jsonValue } from './json-value.ts';
import type { HostPreparedModelRequest } from './ports.ts';
import { type HostTelemetryIds, hostTelemetry } from './telemetry/host-telemetry.ts';
import { hostIntakeMessage } from './turn-input.ts';

/**
 * The summary call's usage receipt, in `model.usage`'s shape: the model it
 * ran on and the SDK usage exactly as reported, cache reads included.
 */
export interface HostContextSummaryUsage {
  readonly modelId: string;
  readonly usage: Json;
}

export interface HostContextSummary extends HostContextSummaryUsage {
  readonly text: string;
}

/** The summary call answered, but not with a summary: its receipt is still billed. */
export class HostContextSummaryRefusal extends BoundaryFailureError {
  readonly receipt: HostContextSummaryUsage;

  constructor(code: string, message: string, receipt: HostContextSummaryUsage) {
    super(fault({ category: 'availability', code, message }));
    this.name = 'HostContextSummaryRefusal';
    this.receipt = receipt;
  }
}

/** The summary call answered outside the required six sections. */
export class HostContextSummarySchemaError extends HostContextSummaryRefusal {
  constructor(receipt: HostContextSummaryUsage) {
    super(
      'compaction.summary-invalid',
      'Compaction summarizer response violated the required six-section schema.',
      receipt
    );
    this.name = 'HostContextSummarySchemaError';
  }
}

/** The summary call answered with a tool call, which never runs. */
export class HostContextSummaryToolCallError extends HostContextSummaryRefusal {
  constructor(receipt: HostContextSummaryUsage) {
    super(
      'compaction.summary-tool-call',
      'Compaction summarizer answered with a tool call instead of a summary.',
      receipt
    );
    this.name = 'HostContextSummaryToolCallError';
  }
}

function requireUsage(count: number | undefined, field: string): void {
  if (!(typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
    throw new BoundaryFailureError(
      fault({
        category: 'availability',
        code: 'compaction.summary-usage-missing',
        message: `Compaction summarizer omitted provider-reported ${field}.`,
      })
    );
  }
}

/** The host's request for the summary, after the run's messages: its words, never the person's. */
const SUMMARY_REQUEST = hostIntakeMessage(
  hostNotice('Brainstrike wrote this request, not the user.', [COMPACTION_SUMMARIZER_INSTRUCTIONS])
);

/** The run's tools as their definitions alone: the provider sees the same tools, and none can run. */
function declared(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([id, tool]) => {
      const { execute: _execute, ...declaration } = tool;
      return [id, declaration];
    })
  );
}

/** The run's next request, as its step sends it, with the model it goes to. */
export type HostStepRequest = Omit<HostPreparedModelRequest, 'model'> & {
  readonly model: LanguageModel;
};

/**
 * The summary, on the run's next request: one step, its tools declared but
 * never run, provider-reported usage required, and the six-section check.
 */
export async function summarizeOnRunRequest(
  request: HostStepRequest & { readonly tools: ToolSet },
  run: HostTelemetryIds & { readonly modelId: string },
  signal: AbortSignal
): Promise<HostContextSummary> {
  const { messages, tools, ...call } = request;
  const result = await generateText({
    ...call,
    abortSignal: signal,
    messages: [...messages, SUMMARY_REQUEST],
    tools: declared(tools),
    ...hostTelemetry('brainstrike.context-compaction', run),
  });
  requireUsage(result.totalUsage.inputTokens, 'inputTokens');
  requireUsage(result.totalUsage.outputTokens, 'outputTokens');
  const receipt = { modelId: run.modelId, usage: jsonValue(result.totalUsage) };
  if (result.toolCalls.length > 0) {
    throw new HostContextSummaryToolCallError(receipt);
  }
  if (!hasCompactionSummarySchema(result.text)) {
    throw new HostContextSummarySchemaError(receipt);
  }
  return { ...receipt, text: result.text };
}
