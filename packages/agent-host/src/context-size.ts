/**
 * How large a thread's next request is (BST-2526). The provider's own count of
 * the branch's latest request, plus what the branch committed after it; only
 * where no count was reported, the chars/4 estimate of the request's messages
 * with the run's instructions and tool definitions.
 */
import { asSchema, type ModelMessage } from 'ai';
import { Schema } from 'effect';
import type { HostRunState } from './core-state.ts';
import { executableInputSchema } from './executable-input-schema.ts';
import type { HostProjectionRewrite, HostTool } from './ports.ts';
import { applyProjectionRewrites } from './projection-rewrites.ts';

export function chars4(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Math.ceil(text.length / 4);
}

type ContentPart = Exclude<ModelMessage['content'], string>[number];

/**
 * Visible-part token estimate over SDK parts: chars/4 of text, tool input and
 * output; an attachment counts as its label, never its inline bytes.
 */
function estimatePart(part: ContentPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return chars4(part.text);
    case 'tool-call':
      return chars4(part.input);
    case 'tool-result':
      return chars4(part.output);
    case 'file':
    case 'image':
      return chars4(`[attachment ${part.mediaType ?? 'unknown'}]`);
    default:
      return 0;
  }
}

/** The chars/4 estimate of `messages`; it also sizes each turn compaction may drop. */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total +=
      typeof message.content === 'string'
        ? chars4(message.content)
        : message.content.reduce((sum, part) => sum + estimatePart(part), 0);
  }
  return total;
}

/** One request's reported size, and where its branch stood when it was sent. */
export interface HostContextReport {
  /** The index in the branch's committed context where what that request did not hold begins. */
  readonly after: number;
  /** The tool calls whose outputs a rewrite replaced after that request was sent. */
  readonly rewritten: readonly string[];
  readonly tokens: number;
}

/**
 * What a run's requests reported, folded from its committed log. A committed
 * compaction clears every run's of its thread: none describes its request any more.
 */
export interface HostReportedContext {
  /** The host's own count on the run's latest `provider.request.prepared` (`accounting.totalTokens`). */
  readonly request?: HostContextReport;
  /** The provider's input tokens on the run's latest `model.step` that reported any. */
  readonly step?: HostContextReport;
}

/** A count no request can have none of: a provider that reports 0 or nothing has not reported. */
const ReportedTokens = Schema.Int.check(Schema.isGreaterThan(0));
const StepUsageSchema = Schema.Struct({ inputTokens: Schema.optional(ReportedTokens) });
const RequestAccountingSchema = Schema.Struct({ totalTokens: ReportedTokens });

/** The input tokens a committed `model.step` usage reports, if its provider reported them. */
export function reportedStepTokens(usage: unknown): number | undefined {
  const decoded = Schema.decodeUnknownResult(StepUsageSchema)(usage);
  return decoded._tag === 'Success' ? decoded.success.inputTokens : undefined;
}

/** The host's own count of a committed `provider.request.prepared` request. */
export function reportedRequestTokens(accounting: unknown): number | undefined {
  const decoded = Schema.decodeUnknownResult(RequestAccountingSchema)(accounting);
  return decoded._tag === 'Success' ? decoded.success.totalTokens : undefined;
}

/** What a run's request carries beside its messages. */
export interface HostRequestExtras {
  readonly instructions?: string;
  readonly tools: Readonly<Record<string, Pick<HostTool, 'description' | 'inputSchema'>>>;
}

async function estimateExtras(extras: HostRequestExtras): Promise<number> {
  const tools = await Promise.all(
    Object.entries(extras.tools).map(async ([name, tool]) =>
      chars4({
        description: tool.description,
        inputSchema: await asSchema(executableInputSchema(tool.inputSchema)).jsonSchema,
        name,
      })
    )
  );
  return (
    (extras.instructions === undefined ? 0 : chars4(extras.instructions)) +
    tools.reduce((total, tokens) => total + tokens, 0)
  );
}

/** The newest run of the branch that holds a `source` report, and that report. */
function latestReport(
  chain: readonly HostRunState[],
  source: keyof HostReportedContext
): HostContextReport | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const report = chain[index]?.reportedContext?.[source];
    if (report) {
      return report;
    }
  }
  return;
}

/** The branch before its tool-output rewrites, and those rewrites. */
export interface HostContextRewrites {
  readonly rewrites?: ReadonlyMap<string, HostProjectionRewrite> | undefined;
  /** The branch's committed context with every tool output as it was committed. */
  readonly unrewritten?: readonly ModelMessage[] | undefined;
}

/**
 * What the rewrites committed after `report` freed from the part of the branch
 * its request held: that part with only the rewrites the request already
 * carried, less that part as the next request carries it.
 */
function freedSince(
  report: HostContextReport,
  messages: readonly ModelMessage[],
  { rewrites, unrewritten }: HostContextRewrites
): number {
  if (report.rewritten.length === 0 || !(rewrites && unrewritten)) {
    return 0;
  }
  const since = new Set(report.rewritten);
  const carried = new Map([...rewrites].filter(([toolCallId]) => !since.has(toolCallId)));
  return (
    estimateTokens(applyProjectionRewrites(unrewritten, carried).slice(0, report.after)) -
    estimateTokens(messages.slice(0, report.after))
  );
}

/**
 * The size of the thread's next request, in this order: the provider's input
 * tokens on the branch's latest step that reported them; else the host's own
 * count of its latest prepared request — each less what tool-output rewrites
 * freed from that request since, plus the chars/4 estimate of what the branch
 * committed after it (that step's output and tool results, the new user
 * message); else `estimate` with the run's instructions and tool definitions.
 * A reported count already holds the instructions, tools and, with Memory,
 * exactly the request Memory built (ADR-0013).
 */
export async function measureHostContext(
  input: HostContextRewrites & {
    readonly chain: readonly HostRunState[];
    /** The chars/4 estimate of the request's messages. */
    readonly estimate: () => number;
    /** The branch's committed context, as its request carries it. */
    readonly messages: readonly ModelMessage[];
    readonly readRequestExtras?: (() => Promise<HostRequestExtras>) | undefined;
  }
): Promise<number> {
  const report = latestReport(input.chain, 'step') ?? latestReport(input.chain, 'request');
  if (report) {
    return (
      report.tokens -
      freedSince(report, input.messages, input) +
      estimateTokens(input.messages.slice(report.after))
    );
  }
  const extras = await input.readRequestExtras?.();
  return input.estimate() + (extras ? await estimateExtras(extras) : 0);
}
