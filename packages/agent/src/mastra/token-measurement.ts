import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import {
  getAccurateTokenCounter,
  getAccurateTokenCountingFailureReason,
  type SyncAccurateCounter,
} from '@brainstrike/utils/token-utils-accurate-lite';
import type { ToolsInput } from '@mastra/core/agent';
import { standardSchemaToJSONSchema, toStandardSchema } from '@mastra/core/schema';

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
  readonly providerReportedPromptTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

function compactMedia(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactMedia);
  }
  if (!isRecord(value)) {
    return value;
  }
  const type = value['type'];
  if (
    typeof type === 'string' &&
    (INLINE_MEDIA_TYPES.has(type) || (URL_MEDIA_TYPES.has(type) && isInlineDataUrl(value['url'])))
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

function serializeToolDefinitions(tools: ToolsInput): string {
  return JSON.stringify(sortedToolDefinitionEntries(tools).map(([, definition]) => definition));
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
  readonly #toolDefinitionBreakdown?: ToolDefinitionContextBreakdown;
  readonly #toolDefinitionCount: number;
  readonly #toolDefinitionFailure?: FailedMeasurement;
  readonly #toolDefinitionMeasurement?: TokenMeasurementSample;

  constructor(params: {
    capability: TokenMeasurementCapability;
    measurement: PreparedTokenMeasurement;
    toolDefinitionBreakdown?: ToolDefinitionContextBreakdown;
    toolDefinitionCount: number;
    toolDefinitionFailure?: FailedMeasurement;
    toolDefinitionMeasurement?: TokenMeasurementSample;
  }) {
    this.#capability = params.capability;
    this.#measurement = params.measurement;
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

  recordModelOutput(output: unknown): void {
    this.#projection.count += 1;
    let serialized: string;
    try {
      serialized = serializeModelOutputForTokenMeasurement(output);
    } catch {
      this.#projection.failure ??= failedMeasurement('projection-serialization-failed');
      return;
    }

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
      toolDefinitionCount: this.#toolDefinitionCount,
    };

    if ('tokenizer' in this.#capability) {
      fields['tokenizer'] = this.#capability.tokenizer;
    }
    if (this.#toolDefinitionMeasurement) {
      fields['toolDefinitionBackstopTokens'] = this.#toolDefinitionMeasurement.backstopTokens;
      fields['toolDefinitionSerializedCharacters'] =
        this.#toolDefinitionMeasurement.serializedCharacters;
      if (this.#toolDefinitionMeasurement.status === 'measured') {
        fields['toolDefinitionTokens'] = this.#toolDefinitionMeasurement.tokenCount;
      }
    }
    if (!this.#projection.failure) {
      fields['modelVisibleProjectionTokens'] = this.#projection.tokenCount;
    }
    if (measurementFailure) {
      fields['measurementFailureCode'] = measurementFailure.failureCode;
    }
    if (options.providerReportedPromptTokens !== undefined) {
      fields['providerReportedPromptTokens'] = options.providerReportedPromptTokens;
    }
    return fields;
  }
}

/**
 * Measure each tool definition individually (sorted descending by tokens).
 * Any serialization or counter failure yields undefined — the caller then
 * omits the breakdown fields entirely rather than shipping partial figures.
 */
function measureToolDefinitionBreakdown(
  tools: ToolsInput,
  measurement: PreparedTokenMeasurement
): ToolDefinitionContextBreakdown | undefined {
  const byTool: ToolDefinitionTokensEntry[] = [];
  let totalTokens = 0;
  for (const [name, definition] of sortedToolDefinitionEntries(tools)) {
    const serialized = JSON.stringify(definition);
    if (serialized === undefined) {
      return;
    }
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
    tools: ToolsInput;
  },
  dependencies: TokenMeasurementDependencies = {}
): Promise<RunTokenDiagnostics> {
  const measurement = await createPreparedTokenMeasurement(params.capability, dependencies);
  const toolDefinitionCount = Object.keys(params.tools).length;
  try {
    const toolDefinitions = serializeToolDefinitions(params.tools);
    const toolDefinitionBreakdown = measureToolDefinitionBreakdown(params.tools, measurement);
    return new RunTokenDiagnostics({
      capability: params.capability,
      measurement,
      ...(toolDefinitionBreakdown ? { toolDefinitionBreakdown } : {}),
      toolDefinitionCount,
      toolDefinitionMeasurement: measurement.measure(toolDefinitions),
    });
  } catch {
    return new RunTokenDiagnostics({
      capability: params.capability,
      measurement,
      toolDefinitionCount,
      toolDefinitionFailure: failedMeasurement('tool-definition-serialization-failed'),
    });
  }
}
