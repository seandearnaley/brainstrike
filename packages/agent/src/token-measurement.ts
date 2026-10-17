import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import {
  getAccurateTokenCounter,
  getAccurateTokenCountingFailureReason,
  type SyncAccurateCounter,
} from '@brainstrike/tokenization/token-utils-accurate-lite';
import { standardSchemaToJSONSchema, toStandardSchema } from '@mastra/core/schema';
import type { HostToolDefinitions as ToolsInput } from './host-tool-definition';
import type { ScaledToolResultBudget } from './stream/tool-output-limits';
import { TOOL_RESULT_TRUNCATED_CODE } from './stream/tool-output-limits';
import { readToolCallTelemetryMetadata } from './tool-projection/tool-call-telemetry';
import type { ToolCallTelemetrySample } from './types';

const MAX_FAILURE_MESSAGE_CHARACTERS = 240;
const INLINE_MEDIA_TYPES = new Set(['file-data', 'image-data', 'media']);
const URL_MEDIA_TYPES = new Set(['file-url', 'image-url']);

export type TokenMeasurementFailureCode =
  | 'counter-execution-failed'
  | 'counter-initialization-failed'
  | 'projection-serialization-failed'
  | 'tool-definition-serialization-failed';

export type TokenMeasurementSample =
  | {
      readonly backstopTokens: number;
      readonly serializedCharacters: number;
      readonly status: 'measured';
      readonly tokenCount: number;
    }
  | {
      readonly backstopTokens: number;
      readonly failureCode: TokenMeasurementFailureCode;
      readonly failureMessage: string;
      readonly serializedCharacters: number;
      readonly status: 'failed';
    };

export interface PreparedTokenMeasurement {
  readonly capability: TokenMeasurementCapability;
  measure(text: string): TokenMeasurementSample;
}

export interface TokenMeasurementDependencies {
  loadCounter?: (
    tokenizer: Extract<TokenMeasurementCapability, { tokenizer: string }>['tokenizer']
  ) => Promise<SyncAccurateCounter | null>;
}

interface FailedMeasurement {
  readonly failureCode: TokenMeasurementFailureCode;
}

interface ProjectionAggregate {
  backstopTokens: number;
  count: number;
  failure?: FailedMeasurement;
  serializedCharacters: number;
  tokenCount: number;
}

export interface RunTokenDiagnosticsLogOptions {
  /**
   * The size of the LAST provider request's context — the number that says
   * whether the prompt is growing.
   */
  readonly latestStepPromptTokens?: number;
  /**
   * Prompt tokens SUMMED across the leg's steps (Mastra's terminal usage
   * restates this sum). This is spend, not context size: a 10-step leg at
   * ~65k context each reads as ~650k here. The 2026-08-23 field incident was
   * this value logged under a name ("providerReportedPromptTokens") that
   * read as a single request's size — diagnosed as a context explosion that
   * did not exist. Never log this without `latestStepPromptTokens` and
   * `stepCount` beside it.
   */
  readonly promptTokensSummedAcrossSteps?: number;
  readonly stepCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Generic (non-search-tool) truncation signal for the telemetry sample.
 * `{type:'json', value:{truncated:true}}` almost never occurs in practice —
 * neither real truncation mechanism produces it directly (review fix):
 *
 * 1. Budget-fit truncation (`stream/tool-output-limits.ts`'s
 *    `trimCollectionToBudget` / the opaque-preview fallback) stamps
 *    `truncated`/`omittedItems`/`code: TOOL_RESULT_TRUNCATED_CODE` on the
 *    DOMAIN record, which the generic projector then JSON-stringifies into a
 *    `{type:'text', value: '<json string>'}` wire shape — the marker survives
 *    inside the string, not as a structured field.
 * 2. Durable-artifact settlement pages (`tool-output-artifact-reader.ts`'s
 *    `buildModelPage`) ARE `{type:'json', value:{...}}`, but signal
 *    continuation via a `next: {input,tool}` object, never a `truncated` key.
 *
 * Bespoke domain projectors (grepSearch, globWorkspace) never reach here for
 * their OWN truncation flag — they attach it via the WeakMap telemetry
 * channel on the raw result before projection, read by the caller of
 * `recordModelOutput` via `readToolCallTelemetryMetadata`.
 */
function detectGenericTruncation(output: unknown): boolean {
  if (!isRecord(output)) {
    return false;
  }
  const value = output['value'];
  if (output['type'] === 'json' && isRecord(value)) {
    return value['truncated'] === true || isRecord(value['next']);
  }
  if (output['type'] === 'text' && typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Plain-text projector output (e.g. a bespoke compact format) — no
      // structured signal available here; not every text-typed tool result
      // is JSON, and that is not itself a truncation indicator.
      return false;
    }
    return (
      isRecord(parsed) &&
      (parsed['truncated'] === true ||
        typeof parsed['omittedItems'] === 'number' ||
        parsed['code'] === TOOL_RESULT_TRUNCATED_CODE)
    );
  }
  return false;
}

function normalizeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= MAX_FAILURE_MESSAGE_CHARACTERS
    ? message
    : `${message.slice(0, MAX_FAILURE_MESSAGE_CHARACTERS - 1)}…`;
}

function countBackstopTokens(text: string, charactersPerToken = 4): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / charactersPerToken);
}

async function loadO200kCounter(): Promise<SyncAccurateCounter> {
  const counter = await getAccurateTokenCounter();
  if (counter) {
    return counter;
  }
  const failureReason = getAccurateTokenCountingFailureReason();
  throw new Error(
    failureReason
      ? `o200k_base counter unavailable: ${failureReason}`
      : 'o200k_base counter unavailable'
  );
}

export async function createPreparedTokenMeasurement(
  capability: TokenMeasurementCapability,
  dependencies: TokenMeasurementDependencies = {}
): Promise<PreparedTokenMeasurement> {
  if (capability.mode === 'deterministic-serialized-character-backstop') {
    return {
      capability,
      measure: (text) => {
        const backstopTokens = countBackstopTokens(text, capability.charactersPerToken);
        return {
          backstopTokens,
          serializedCharacters: text.length,
          status: 'measured',
          tokenCount: backstopTokens,
        };
      },
    };
  }

  let counter: SyncAccurateCounter | null = null;
  let initializationFailure: string | undefined;
  try {
    const loadCounter = dependencies.loadCounter ?? loadO200kCounter;
    counter = await loadCounter(capability.tokenizer);
    if (!counter) {
      initializationFailure = `${capability.tokenizer} counter loader returned no counter`;
    }
  } catch (error) {
    initializationFailure = normalizeFailureMessage(error);
  }

  return {
    capability,
    measure: (text) => {
      const base = {
        backstopTokens: countBackstopTokens(text),
        serializedCharacters: text.length,
      };
      if (initializationFailure) {
        return {
          ...base,
          failureCode: 'counter-initialization-failed',
          failureMessage: initializationFailure,
          status: 'failed',
        };
      }
      if (!counter) {
        return {
          ...base,
          failureCode: 'counter-initialization-failed',
          failureMessage: `${capability.tokenizer} counter is unavailable`,
          status: 'failed',
        };
      }
      try {
        const tokenCount = counter(text);
        if (!(Number.isSafeInteger(tokenCount) && tokenCount >= 0)) {
          throw new Error(`counter returned invalid token count: ${tokenCount}`);
        }
        return {
          ...base,
          status: 'measured',
          tokenCount,
        };
      } catch (error) {
        return {
          ...base,
          failureCode: 'counter-execution-failed',
          failureMessage: normalizeFailureMessage(error),
          status: 'failed',
        };
      }
    },
  };
}

function mediaTypeFromPart(part: Record<string, unknown>): string {
  if (typeof part['mediaType'] === 'string' && part['mediaType'].length > 0) {
    return part['mediaType'];
  }
  if (typeof part['url'] !== 'string' || !part['url'].startsWith('data:')) {
    return 'unknown';
  }
  const metadataEnd = part['url'].indexOf(',');
  const metadata = metadataEnd >= 0 ? part['url'].slice(5, metadataEnd) : '';
  return metadata.split(';', 1)[0] || 'text/plain';
}

function isInlineDataUrl(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('data:') && value.indexOf(',') >= 5;
}

/** SDK 7 file parts tag bytes separately; text, remote URLs and references still count. */
function isInlineProviderFile(part: Record<string, unknown>): boolean {
  if (part['type'] !== 'file' && part['type'] !== 'reasoning-file') {
    return false;
  }
  const data = part['data'];
  return (
    isRecord(data) &&
    (data['type'] === 'data' ||
      (data['type'] === 'url' && data['url'] instanceof URL && data['url'].protocol === 'data:'))
  );
}

function compactMedia(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactMedia);
  }
  if (value instanceof URL || value instanceof Date) {
    return value.toJSON();
  }
  if (!isRecord(value)) {
    return value;
  }
  const type = value['type'];
  if (
    typeof type === 'string' &&
    (INLINE_MEDIA_TYPES.has(type) ||
      (URL_MEDIA_TYPES.has(type) && isInlineDataUrl(value['url'])) ||
      isInlineProviderFile(value))
  ) {
    return {
      text: `[${type} payload omitted from token count; media type: ${mediaTypeFromPart(value)}]`,
      type: 'text',
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compactMedia(entry)])
  );
}

export function serializeModelOutputForTokenMeasurement(output: unknown): string {
  const serialized = JSON.stringify(compactMedia(output));
  if (serialized === undefined) {
    throw new TypeError('Model output projection could not be serialized for token measurement');
  }
  return serialized;
}

function toToolDefinitionEntry(name: string, tool: unknown): Record<string, unknown> {
  const toolRecord = tool as Record<string, unknown>;
  if (
    toolRecord['type'] === 'provider' &&
    toolRecord['isProviderExecuted'] === true &&
    typeof toolRecord['id'] === 'string'
  ) {
    // AI SDK provider tools expose lazy function schemas, while the provider
    // request is defined by the stable provider id and serializable args.
    return {
      name,
      providerTool: {
        args: toolRecord['args'] ?? {},
        id: toolRecord['id'],
        type: 'provider',
      },
    };
  }
  const inputSchema = toolRecord['inputSchema'] ?? toolRecord['parameters'];
  return {
    description: typeof toolRecord['description'] === 'string' ? toolRecord['description'] : '',
    ...(inputSchema === undefined || inputSchema === null
      ? { schemaAvailable: false }
      : {
          inputSchema: standardSchemaToJSONSchema(
            toStandardSchema(inputSchema as Parameters<typeof toStandardSchema>[0]),
            {
              io: 'input',
            }
          ),
        }),
    name,
  };
}

function sortedToolDefinitionEntries(tools: ToolsInput): [string, Record<string, unknown>][] {
  return Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => [name, toToolDefinitionEntry(name, tool)]);
}

function serializeToolDefinitionEntries(tools: ToolsInput): [string, string][] {
  return sortedToolDefinitionEntries(tools).map(([name, definition]) => [
    name,
    JSON.stringify(definition),
  ]);
}

function measureToolDefinitionBatch(
  tools: ToolsInput,
  measurement: PreparedTokenMeasurement
): {
  readonly measurement: TokenMeasurementSample;
  readonly serializedEntries: [string, string][];
} {
  const serializedEntries = serializeToolDefinitionEntries(tools);
  const serializedBatch = `[${serializedEntries.map(([, json]) => json).join(',')}]`;
  return { measurement: measurement.measure(serializedBatch), serializedEntries };
}

function failedMeasurement(code: TokenMeasurementFailureCode): FailedMeasurement {
  return { failureCode: code };
}

/** One tool's measured definition share, for the context-breakdown wire part. */
export interface ToolDefinitionTokensEntry {
  readonly name: string;
  readonly tokens: number;
}

/**
 * Per-tool definition token figures for the context usage popover. `provenance`
 * distinguishes tokenizer-backed counts from the chars/4 backstop; `undefined`
 * (from the diagnostics accessor) means measurement failed — the breakdown
 * omits the fields rather than zero-faking them.
 */
export interface ToolDefinitionContextBreakdown {
  readonly byTool: readonly ToolDefinitionTokensEntry[];
  readonly provenance: 'heuristic' | 'measured';
  readonly totalTokens: number;
}

export class RunTokenDiagnostics {
  readonly #capability: TokenMeasurementCapability;
  readonly #measurement: PreparedTokenMeasurement;
  readonly #projection: ProjectionAggregate = {
    backstopTokens: 0,
    count: 0,
    serializedCharacters: 0,
    tokenCount: 0,
  };
  readonly #resolvedToolResultBudget: ScaledToolResultBudget;
  readonly #toolDefinitionBreakdown?: ToolDefinitionContextBreakdown;
  #additionalToolDefinitionBackstopTokens = 0;
  #additionalToolDefinitionSerializedCharacters = 0;
  #additionalToolDefinitionTokens = 0;
  #toolDefinitionCount: number;
  readonly #toolDefinitionFailure?: FailedMeasurement;
  readonly #toolDefinitionMeasurement?: TokenMeasurementSample;
  readonly #toolCallTelemetry: ToolCallTelemetrySample[] = [];

  constructor(params: {
    capability: TokenMeasurementCapability;
    measurement: PreparedTokenMeasurement;
    resolvedToolResultBudget: ScaledToolResultBudget;
    toolDefinitionBreakdown?: ToolDefinitionContextBreakdown;
    toolDefinitionCount: number;
    toolDefinitionFailure?: FailedMeasurement;
    toolDefinitionMeasurement?: TokenMeasurementSample;
  }) {
    this.#capability = params.capability;
    this.#measurement = params.measurement;
    this.#resolvedToolResultBudget = params.resolvedToolResultBudget;
    this.#toolDefinitionCount = params.toolDefinitionCount;
    if (params.toolDefinitionBreakdown) {
      this.#toolDefinitionBreakdown = params.toolDefinitionBreakdown;
    }
    if (params.toolDefinitionFailure) {
      this.#toolDefinitionFailure = params.toolDefinitionFailure;
    }
    if (params.toolDefinitionMeasurement) {
      this.#toolDefinitionMeasurement = params.toolDefinitionMeasurement;
    }
  }

  /**
   * Per-tool definition figures for the context-breakdown wire part, or
   * undefined when measurement failed (the breakdown then omits its
   * tool-definition fields — absent, never zero-faked).
   */
  toolDefinitionContextBreakdown(): ToolDefinitionContextBreakdown | undefined {
    return this.#toolDefinitionBreakdown;
  }

  /**
   * Telemetry-only sample push, deliberately independent of the token
   * measurement in `recordModelOutput`: `serializeModelOutputForTokenMeasurement`
   * masks inline media (`compactMedia`) specifically so it cannot throw on a
   * huge base64 payload, but the telemetry figure wants the ACTUAL
   * model-facing char count including media. A failure here (e.g.
   * `RangeError: Invalid string length`) must not degrade the pre-existing,
   * already-shipped token measurement — best-effort telemetry stays
   * best-effort (review fix); the sample is simply omitted for this call.
   */
  #pushToolCallTelemetrySample(toolId: string, output: unknown): void {
    let modelFacingChars: number | undefined;
    try {
      modelFacingChars = JSON.stringify(output)?.length;
    } catch {
      modelFacingChars = undefined;
    }
    if (modelFacingChars === undefined) {
      return;
    }
    const metadata = readToolCallTelemetryMetadata(output);
    this.#toolCallTelemetry.push({
      candidatesTruncated: metadata?.candidatesTruncated ?? false,
      isPaginationFollowup: metadata?.isPaginationFollowup ?? false,
      modelFacingChars,
      occurredAt: Date.now(),
      scanLimited: metadata?.scanLimited ?? false,
      toolId,
      truncated: detectGenericTruncation(output) || (metadata?.truncated ?? false),
      ...(metadata?.engine === undefined ? {} : { engine: metadata.engine }),
      ...(metadata ? { zeroMatch: metadata.zeroMatch } : {}),
    });
  }

  /**
   * Telemetry-only sink for delegated/subagent tool outputs (BST-1196).
   * Pushes a `ToolCallTelemetrySample` so per-tool spend telemetry captures
   * subagent tool calls too, WITHOUT touching the `#projection` aggregate
   * below. `modelVisibleProjection*` (surfaced via `toLogFields`) is a
   * reconciliation signal against `providerReportedPromptTokens` — what the
   * PARENT model actually saw in ITS prompt. A subagent tool output never
   * enters the parent's prompt (only the delegation's final result does), so
   * folding it into that aggregate would inflate
   * `modelVisibleProjectionCount/Tokens/SerializedCharacters` against an
   * unchanged `providerReportedPromptTokens` for every run that delegates,
   * corrupting the exact reconciliation this log exists to provide (review
   * fix).
   */
  recordSubagentToolOutput(toolId: string, output: unknown): void {
    this.#pushToolCallTelemetrySample(toolId, output);
  }

  recordModelOutput(toolId: string, output: unknown): void {
    this.#projection.count += 1;
    let serialized: string;
    try {
      serialized = serializeModelOutputForTokenMeasurement(output);
    } catch {
      this.#projection.failure ??= failedMeasurement('projection-serialization-failed');
      return;
    }

    this.#pushToolCallTelemetrySample(toolId, output);

    const sample = this.#measurement.measure(serialized);
    this.#projection.backstopTokens += sample.backstopTokens;
    this.#projection.serializedCharacters += sample.serializedCharacters;
    if (sample.status === 'failed') {
      this.#projection.failure ??= {
        failureCode: sample.failureCode,
      };
      return;
    }
    this.#projection.tokenCount += sample.tokenCount;
  }

  /** Best-effort accounting for definitions loaded after the run began. */
  recordAdditionalToolDefinitions(tools: ToolsInput): void {
    const toolDefinitionCount = Object.keys(tools).length;
    if (toolDefinitionCount === 0) {
      return;
    }
    try {
      const sample = measureToolDefinitionBatch(tools, this.#measurement).measurement;
      if (sample.status === 'failed') {
        return;
      }
      this.#additionalToolDefinitionBackstopTokens += sample.backstopTokens;
      this.#additionalToolDefinitionSerializedCharacters += sample.serializedCharacters;
      this.#additionalToolDefinitionTokens += sample.tokenCount;
      this.#toolDefinitionCount += toolDefinitionCount;
      // Intentionally excluded from toolDefinitionContextBreakdown().byTool;
      // that UI-facing per-tool list is a separate run-start concern.
    } catch {
      // Deferred definition measurement is best-effort and never aborts a run.
    }
  }

  /** Counts, sizes, ids, and booleans only; never projected content. */
  toolCallTelemetry(): readonly ToolCallTelemetrySample[] {
    return this.#toolCallTelemetry.map((entry) => ({ ...entry }));
  }

  toLogFields(options: RunTokenDiagnosticsLogOptions = {}): Record<string, number | string> {
    const measurementFailure =
      this.#toolDefinitionFailure ??
      (this.#toolDefinitionMeasurement?.status === 'failed'
        ? {
            failureCode: this.#toolDefinitionMeasurement.failureCode,
          }
        : undefined) ??
      this.#projection.failure;
    const fields: Record<string, number | string> = {
      measurementMode: this.#capability.mode,
      measurementStatus: measurementFailure ? 'failed' : 'measured',
      modelVisibleProjectionBackstopTokens: this.#projection.backstopTokens,
      modelVisibleProjectionCount: this.#projection.count,
      modelVisibleProjectionSerializedCharacters: this.#projection.serializedCharacters,
      resolvedDomainBudgetTokens: this.#resolvedToolResultBudget.domainModelResultTokens,
      resolvedTransportBudgetTokens: this.#resolvedToolResultBudget.transportResultTokens,
      toolDefinitionCount: this.#toolDefinitionCount,
    };

    if ('tokenizer' in this.#capability) {
      fields['tokenizer'] = this.#capability.tokenizer;
    }
    if (this.#toolDefinitionMeasurement || this.#additionalToolDefinitionBackstopTokens > 0) {
      fields['toolDefinitionBackstopTokens'] =
        (this.#toolDefinitionMeasurement?.backstopTokens ?? 0) +
        this.#additionalToolDefinitionBackstopTokens;
      fields['toolDefinitionSerializedCharacters'] =
        (this.#toolDefinitionMeasurement?.serializedCharacters ?? 0) +
        this.#additionalToolDefinitionSerializedCharacters;
      if (
        !this.#toolDefinitionMeasurement ||
        this.#toolDefinitionMeasurement.status === 'measured'
      ) {
        fields['toolDefinitionTokens'] =
          (this.#toolDefinitionMeasurement?.status === 'measured'
            ? this.#toolDefinitionMeasurement.tokenCount
            : 0) + this.#additionalToolDefinitionTokens;
      }
    }
    if (!this.#projection.failure) {
      fields['modelVisibleProjectionTokens'] = this.#projection.tokenCount;
    }
    if (measurementFailure) {
      fields['measurementFailureCode'] = measurementFailure.failureCode;
    }
    if (options.promptTokensSummedAcrossSteps !== undefined) {
      fields['promptTokensSummedAcrossSteps'] = options.promptTokensSummedAcrossSteps;
    }
    if (options.latestStepPromptTokens !== undefined) {
      fields['latestStepPromptTokens'] = options.latestStepPromptTokens;
    }
    if (options.stepCount !== undefined) {
      fields['stepCount'] = options.stepCount;
    }
    return fields;
  }
}

/**
 * Measure each already-serialized tool definition (sorted descending by
 * tokens). Any counter failure yields undefined — the caller then omits the
 * breakdown fields entirely rather than shipping partial figures.
 */
function measureToolDefinitionBreakdown(
  serializedEntries: readonly [string, string][],
  measurement: PreparedTokenMeasurement
): ToolDefinitionContextBreakdown | undefined {
  const byTool: ToolDefinitionTokensEntry[] = [];
  let totalTokens = 0;
  for (const [name, serialized] of serializedEntries) {
    const sample = measurement.measure(serialized);
    if (sample.status === 'failed') {
      return;
    }
    byTool.push({ name, tokens: sample.tokenCount });
    totalTokens += sample.tokenCount;
  }
  byTool.sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  return {
    byTool,
    provenance:
      measurement.capability.mode === 'deterministic-serialized-character-backstop'
        ? 'heuristic'
        : 'measured',
    totalTokens,
  };
}

export async function createRunTokenDiagnostics(
  params: {
    capability: TokenMeasurementCapability;
    resolvedToolResultBudget: ScaledToolResultBudget;
    tools: ToolsInput;
  },
  dependencies: TokenMeasurementDependencies = {}
): Promise<RunTokenDiagnostics> {
  const measurement = await createPreparedTokenMeasurement(params.capability, dependencies);
  const toolDefinitionCount = Object.keys(params.tools).length;
  try {
    // ONE schema-conversion + serialization pass feeds both the aggregate
    // measurement (log fields) and the per-tool breakdown — with large MCP
    // tool surfaces the double toStandardSchema/JSON walk was measurable
    // run-start latency (review fix).
    const toolDefinitionBatch = measureToolDefinitionBatch(params.tools, measurement);
    const serializedEntries = toolDefinitionBatch.serializedEntries;
    const toolDefinitionBreakdown = measureToolDefinitionBreakdown(serializedEntries, measurement);
    return new RunTokenDiagnostics({
      capability: params.capability,
      measurement,
      resolvedToolResultBudget: params.resolvedToolResultBudget,
      ...(toolDefinitionBreakdown ? { toolDefinitionBreakdown } : {}),
      toolDefinitionCount,
      toolDefinitionMeasurement: toolDefinitionBatch.measurement,
    });
  } catch {
    return new RunTokenDiagnostics({
      capability: params.capability,
      measurement,
      resolvedToolResultBudget: params.resolvedToolResultBudget,
      toolDefinitionCount,
      toolDefinitionFailure: failedMeasurement('tool-definition-serialization-failed'),
    });
  }
}
