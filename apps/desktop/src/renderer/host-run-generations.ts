import { type HostLedgerThread, ThreadLedgerFold } from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { capturedEffort } from '@brainstrike/app-shell';
import { modelVendor } from '@brainstrike/assistant-contract/model-vendors';
import { getProviderDisplayName } from '@brainstrike/assistant-contract/provider-metadata';
import {
  findModelVendor,
  resolveModelLabel,
} from '@brainstrike/assistant-contract/provider-registry';
import type {
  GenerationDetails,
  GenerationDetailsSource,
  GenerationTokens,
} from '@brainstrike/assistant-ui';
import { Schema } from 'effect';
import { admittedExecution } from './host-child-details';
import type { CommittedHostRunSource } from './host-thread-runs';

const Count = Schema.optional(Schema.Finite);
/** The AI SDK step usage Core commits on `model.step`; an unreported count reads as none. */
const StepUsageSchema = Schema.Struct({
  inputTokenDetails: Schema.optional(
    Schema.Struct({ cacheReadTokens: Count, cacheWriteTokens: Count })
  ),
  inputTokens: Count,
  outputTokenDetails: Schema.optional(Schema.Struct({ reasoningTokens: Count })),
  outputTokens: Count,
});
/** The parts of a committed `finish-step` chunk a generation's details read. */
const FinishStepSchema = Schema.Struct({
  finishReason: Schema.optional(Schema.String),
  performance: Schema.optional(
    Schema.Struct({
      responseTimeMs: Count,
      timeToFirstOutputMs: Count,
    })
  ),
  response: Schema.optional(Schema.Struct({ modelId: Schema.optional(Schema.String) })),
  type: Schema.Literal('finish-step'),
});
const FinishSchema = Schema.Struct({
  finishReason: Schema.optional(Schema.String),
  type: Schema.Literal('finish'),
});
const decodeUsage = Schema.decodeUnknownOption(StepUsageSchema);
const decodeFinishStep = Schema.decodeUnknownOption(FinishStepSchema);
const decodeFinish = Schema.decodeUnknownOption(FinishSchema);

/** One run's committed facts, as its rows arrive. */
interface RunFacts {
  effort: string | undefined;
  finishReason: string | undefined;
  firstOutputMs: number | undefined;
  model: string;
  modelTimeMs: number | undefined;
  outcome: GenerationDetails['outcome'];
  provider: string;
  servedModel: string | undefined;
  steps: number;
  tokens: GenerationTokens;
  /** Bumped by each row that changes these facts. */
  version: number;
}

function startedFacts(event: Extract<HostLogRow['event'], { type: 'run.started' }>): RunFacts {
  const separator = event.modelId.indexOf('::');
  const provider = separator > 0 ? event.modelId.slice(0, separator) : '';
  const model = separator > 0 ? event.modelId.slice(separator + 2) : event.modelId;
  const { execution } = admittedExecution(event.snapshot?.configuration, event.planMode === true);
  return {
    effort: execution ? capturedEffort(execution) : undefined,
    finishReason: undefined,
    firstOutputMs: undefined,
    model,
    modelTimeMs: undefined,
    outcome: undefined,
    provider,
    servedModel: undefined,
    steps: 0,
    tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, reasoning: 0 },
    version: 0,
  };
}

function addUsage(tokens: GenerationTokens, usage: unknown): GenerationTokens {
  const parsed = decodeUsage(usage);
  if (parsed._tag === 'None') {
    return tokens;
  }
  const step = parsed.value;
  return {
    cacheRead: tokens.cacheRead + (step.inputTokenDetails?.cacheReadTokens ?? 0),
    cacheWrite: tokens.cacheWrite + (step.inputTokenDetails?.cacheWriteTokens ?? 0),
    input: tokens.input + (step.inputTokens ?? 0),
    output: tokens.output + (step.outputTokens ?? 0),
    reasoning: tokens.reasoning + (step.outputTokenDetails?.reasoningTokens ?? 0),
  };
}

/** Facts the run's cost views own: its cost, tool calls and wall time. */
interface LedgerFacts {
  /** Absent when the catalog has no rates for one of the run's unbilled calls. */
  readonly cost: GenerationDetails['cost'];
  readonly durationMs: number | null;
  readonly toolCalls: number;
}

/**
 * What the provider billed, when it billed every call; otherwise billed plus
 * the catalog price of the rest, an estimate. An unpriced run shows no cost,
 * never $0 (docs/agents/assistant-persistence.md).
 */
function runCost(run: HostLedgerThread['runs'][number]): GenerationDetails['cost'] {
  const estimated = run.estimatedInputTokens + run.estimatedOutputTokens > 0;
  if (run.billedCostUsd !== undefined && !estimated) {
    return { basis: 'billed', usd: run.billedCostUsd };
  }
  return run.estimatedCostUsd === null
    ? undefined
    : { basis: 'estimated', usd: (run.billedCostUsd ?? 0) + run.estimatedCostUsd };
}

/**
 * The details of every run a mounted thread view shows, read by run ID from
 * the view's committed log. Tokens, steps and timings come from the run's own
 * `model.step` and `finish-step` rows; cost, tool calls and wall time from
 * the same ledger fold the cost views use, so the figures agree with them.
 * Each run's value keeps its identity until one of its facts changes.
 */
export class HostRunGenerations implements GenerationDetailsSource {
  private cursor = 0;
  private readonly runs = new Map<string, RunFacts>();
  private readonly ledger = new ThreadLedgerFold();
  private ledgerSeq = -1;
  private ledgerRuns = new Map<string, LedgerFacts>();
  private readonly values = new Map<
    string,
    {
      readonly ledger: LedgerFacts | undefined;
      readonly value: GenerationDetails;
      readonly version: number;
    }
  >();

  private readonly source: CommittedHostRunSource;

  constructor(source: CommittedHostRunSource) {
    this.source = source;
  }

  readonly subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener);

  readonly read = (runId: string): GenerationDetails | undefined => {
    this.sync();
    const facts = this.runs.get(runId);
    if (!facts) {
      return;
    }
    const ledger = this.ledgerFacts().get(runId);
    const cached = this.values.get(runId);
    if (cached && cached.version === facts.version && sameLedger(cached.ledger, ledger)) {
      return cached.value;
    }
    const value = details(facts, ledger);
    this.values.set(runId, { ledger, value, version: facts.version });
    return value;
  };

  private sync(): void {
    const { rows } = this.source.getSnapshot();
    if (rows.length < this.cursor) {
      throw new Error('A committed thread log never shrinks');
    }
    for (const row of rows.slice(this.cursor)) {
      this.ledger.apply(row);
      this.apply(row);
    }
    this.cursor = rows.length;
  }

  private apply({ event }: HostLogRow): void {
    if (event.type === 'run.started') {
      this.runs.set(event.runId, startedFacts(event));
      return;
    }
    const facts = 'runId' in event ? this.runs.get(event.runId) : undefined;
    if (!facts) {
      return;
    }
    if (event.type === 'model.step') {
      facts.steps += 1;
      facts.tokens = addUsage(facts.tokens, event.usage);
      facts.version += 1;
    } else if (event.type === 'run.finished') {
      facts.outcome = event.outcome;
      facts.version += 1;
    } else if (event.type === 'stream.chunk') {
      this.chunk(facts, event.chunk);
    }
  }

  private chunk(facts: RunFacts, chunk: unknown): void {
    const step = decodeFinishStep(chunk);
    if (step._tag === 'Some') {
      const { performance, response } = step.value;
      facts.firstOutputMs ??= performance?.timeToFirstOutputMs;
      if (performance?.responseTimeMs !== undefined) {
        facts.modelTimeMs = (facts.modelTimeMs ?? 0) + performance.responseTimeMs;
      }
      const served = response?.modelId;
      facts.servedModel = served && served !== facts.model ? served : facts.servedModel;
      facts.finishReason = step.value.finishReason ?? facts.finishReason;
      facts.version += 1;
      return;
    }
    const finish = decodeFinish(chunk);
    if (finish._tag === 'Some' && finish.value.finishReason) {
      facts.finishReason = finish.value.finishReason;
      facts.version += 1;
    }
  }

  /** The ledger's runs, read once per committed row the fold took. */
  private ledgerFacts(): ReadonlyMap<string, LedgerFacts> {
    if (this.ledger.seq !== this.ledgerSeq) {
      this.ledgerSeq = this.ledger.seq;
      this.ledgerRuns = new Map(
        this.ledger.read().runs.map((run) => [
          run.runId,
          {
            cost: runCost(run),
            durationMs: run.durationMs,
            toolCalls: run.toolCallCount,
          },
        ])
      );
    }
    return this.ledgerRuns;
  }
}

function sameLedger(a: LedgerFacts | undefined, b: LedgerFacts | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.cost?.basis === b.cost?.basis &&
      a.cost?.usd === b.cost?.usd &&
      a.durationMs === b.durationMs &&
      a.toolCalls === b.toolCalls)
  );
}

function details(facts: RunFacts, ledger: LedgerFacts | undefined): GenerationDetails {
  const vendor = findModelVendor(facts.provider, facts.model);
  return {
    ...(ledger?.cost ? { cost: ledger.cost } : {}),
    ...(facts.effort ? { effort: facts.effort } : {}),
    ...(facts.finishReason ? { finishReason: facts.finishReason } : {}),
    ...(facts.firstOutputMs === undefined ? {} : { firstOutputMs: facts.firstOutputMs }),
    model: { id: facts.model, label: resolveModelLabel(facts.provider, facts.model) },
    ...(facts.modelTimeMs === undefined ? {} : { modelTimeMs: facts.modelTimeMs }),
    ...(facts.outcome ? { outcome: facts.outcome } : {}),
    provider: { id: facts.provider, name: getProviderDisplayName(facts.provider) },
    ...(facts.servedModel ? { servedModel: facts.servedModel } : {}),
    steps: facts.steps,
    tokens: facts.tokens,
    ...(ledger ? { toolCalls: ledger.toolCalls } : {}),
    ...(vendor ? { vendor: modelVendor(vendor) } : {}),
    ...(ledger?.durationMs === null || ledger === undefined
      ? {}
      : { wallTimeMs: ledger.durationMs }),
  };
}
