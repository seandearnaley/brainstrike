import type { OpenAiReasoningEffort } from './runtime-data.js';

export const OPENROUTER_MODEL_METADATA_SOURCE = 'openrouter-models-api' as const;

const MAX_SUPPORTED_PARAMETERS = 64;
const MAX_SUPPORTED_PARAMETER_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_WARNING_LENGTH = 300;
const OPENROUTER_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export interface OpenRouterReasoningMetadata {
  readonly defaultEffort?: OpenAiReasoningEffort;
  readonly defaultEnabled?: boolean;
  readonly mandatory: boolean;
  readonly supportedEfforts?: readonly OpenAiReasoningEffort[];
  readonly supportsMaxTokens: boolean;
}

export interface OpenRouterModelMetadata {
  readonly checkedAt: number;
  readonly contextWindow: number;
  readonly id: string;
  readonly maxOutputTokens?: number;
  readonly reasoning?: OpenRouterReasoningMetadata;
  readonly source: typeof OPENROUTER_MODEL_METADATA_SOURCE;
  readonly supportedParameters: readonly string[];
}

export type OpenRouterModelMetadataSnapshot =
  | {
      readonly freshness: 'live' | 'fresh-cache';
      readonly metadata: OpenRouterModelMetadata;
    }
  | {
      readonly freshness: 'stale-cache';
      readonly metadata: OpenRouterModelMetadata;
      readonly warning: string;
    };

export type OpenRouterModelMetadataLookup =
  | { readonly state: 'loading' }
  | { readonly state: 'resolved'; readonly snapshot: OpenRouterModelMetadataSnapshot }
  | { readonly message: string; readonly state: 'error' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!(Number.isSafeInteger(value) && (value as number) > 0)) {
    throw new Error(`OpenRouter model metadata requires a positive integer ${field}`);
  }
  return value as number;
}

function parseSupportedParameters(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenRouter model metadata requires supported_parameters to be an array');
  }
  if (value.length > MAX_SUPPORTED_PARAMETERS) {
    throw new Error(
      `OpenRouter model metadata supports at most ${MAX_SUPPORTED_PARAMETERS} supported_parameters`
    );
  }

  return value.map((parameter) => {
    if (
      typeof parameter !== 'string' ||
      parameter.length === 0 ||
      parameter.length > MAX_SUPPORTED_PARAMETER_LENGTH
    ) {
      throw new Error('OpenRouter model metadata contains an invalid supported_parameters value');
    }
    return parameter;
  });
}

function parseReasoningEffort(value: unknown, field: string): OpenAiReasoningEffort {
  if (!(typeof value === 'string' && OPENROUTER_REASONING_EFFORTS.has(value))) {
    throw new Error(`OpenRouter model metadata contains an invalid ${field}`);
  }
  return value as OpenAiReasoningEffort;
}

function parseReasoningMetadata(value: unknown): OpenRouterReasoningMetadata | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error('OpenRouter model metadata reasoning must be an object');
  }
  if (typeof value['mandatory'] !== 'boolean') {
    throw new Error('OpenRouter model metadata reasoning.mandatory must be a boolean');
  }
  if (value['default_enabled'] !== undefined && typeof value['default_enabled'] !== 'boolean') {
    throw new Error('OpenRouter model metadata reasoning.default_enabled must be a boolean');
  }
  const rawEfforts = value['supported_efforts'];
  if (
    rawEfforts !== undefined &&
    !(Array.isArray(rawEfforts) && rawEfforts.length > 0 && rawEfforts.length <= 7)
  ) {
    throw new Error(
      'OpenRouter model metadata reasoning.supported_efforts must be a non-empty bounded array'
    );
  }
  const supportedEfforts = Array.isArray(rawEfforts)
    ? rawEfforts.map((effort) => parseReasoningEffort(effort, 'reasoning.supported_efforts value'))
    : undefined;
  if (
    supportedEfforts !== undefined &&
    new Set(supportedEfforts).size !== supportedEfforts.length
  ) {
    throw new Error('OpenRouter model metadata reasoning.supported_efforts must be unique');
  }
  const rawDefaultEffort = value['default_effort'];
  const defaultEffort =
    rawDefaultEffort === undefined
      ? undefined
      : parseReasoningEffort(rawDefaultEffort, 'reasoning.default_effort');
  if (
    defaultEffort !== undefined &&
    supportedEfforts !== undefined &&
    !supportedEfforts.includes(defaultEffort)
  ) {
    throw new Error(
      'OpenRouter model metadata reasoning.default_effort must appear in supported_efforts'
    );
  }
  const rawSupportsMaxTokens = value['supports_max_tokens'];
  if (rawSupportsMaxTokens !== undefined && typeof rawSupportsMaxTokens !== 'boolean') {
    throw new Error('OpenRouter model metadata reasoning.supports_max_tokens must be a boolean');
  }
  return {
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(value['default_enabled'] === undefined ? {} : { defaultEnabled: value['default_enabled'] }),
    mandatory: value['mandatory'],
    ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    supportsMaxTokens: rawSupportsMaxTokens === true,
  };
}

export function parseOpenRouterModelMetadata(
  payload: unknown,
  expectedModelId: string,
  checkedAt: number
): OpenRouterModelMetadata {
  if (!(isRecord(payload) && isRecord(payload['data']))) {
    throw new Error('OpenRouter model metadata requires a data object');
  }
  const data = payload['data'];
  if (data['id'] !== expectedModelId) {
    throw new Error(`OpenRouter model metadata did not return expected model "${expectedModelId}"`);
  }

  const modelContextWindow = requirePositiveInteger(data['context_length'], 'context_length');
  const supportedParameters = parseSupportedParameters(data['supported_parameters']);
  const reasoning = parseReasoningMetadata(data['reasoning']);
  const topProvider = data['top_provider'];
  if (!isRecord(topProvider)) {
    throw new Error('OpenRouter model metadata requires a top_provider object');
  }
  // The window and output limit are the TOP PROVIDER's pair: a larger
  // model-level `context_length` may be served by only one provider, so it is
  // not paired with another provider's `max_completion_tokens`. The API
  // publishes a null top-provider window for router meta-models only; then
  // the model-level window is the only one published, so it is used. The key
  // itself is always published, so an ABSENT window is malformed and throws.
  const rawTopContextWindow = topProvider['context_length'];
  const contextWindow =
    rawTopContextWindow === null
      ? modelContextWindow
      : requirePositiveInteger(rawTopContextWindow, 'top_provider.context_length');

  const rawMaxOutputTokens = topProvider['max_completion_tokens'];
  if (rawMaxOutputTokens === undefined || rawMaxOutputTokens === null) {
    return {
      checkedAt,
      contextWindow,
      id: expectedModelId,
      ...(reasoning === undefined ? {} : { reasoning }),
      source: OPENROUTER_MODEL_METADATA_SOURCE,
      supportedParameters,
    };
  }

  const maxOutputTokens = requirePositiveInteger(
    rawMaxOutputTokens,
    'top_provider.max_completion_tokens'
  );
  if (maxOutputTokens > contextWindow) {
    throw new Error('OpenRouter max_completion_tokens cannot exceed context_length');
  }

  return {
    checkedAt,
    contextWindow,
    id: expectedModelId,
    maxOutputTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
    source: OPENROUTER_MODEL_METADATA_SOURCE,
    supportedParameters,
  };
}

function parseSnapshotMetadata(value: unknown): OpenRouterModelMetadata {
  if (!isRecord(value)) {
    throw new Error('OpenRouter model metadata snapshot requires metadata');
  }
  const id = value['id'];
  if (!(typeof id === 'string' && id.length > 0 && id.length <= MAX_MODEL_ID_LENGTH)) {
    throw new Error('OpenRouter model metadata snapshot requires a valid model id');
  }
  if (value['source'] !== OPENROUTER_MODEL_METADATA_SOURCE) {
    throw new Error('OpenRouter model metadata snapshot has an invalid source');
  }

  const checkedAt = requirePositiveInteger(value['checkedAt'], 'checkedAt');
  // The snapshot's window is already the resolved top-provider window, so it
  // round-trips as that field; the model-level field carries the same value.
  const topProvider: Record<string, unknown> = {};
  topProvider['context_length'] = value['contextWindow'];
  if (value['maxOutputTokens'] !== undefined) {
    topProvider['max_completion_tokens'] = value['maxOutputTokens'];
  }
  const data: Record<string, unknown> = { id };
  data['context_length'] = value['contextWindow'];
  data['supported_parameters'] = value['supportedParameters'];
  data['top_provider'] = topProvider;
  if (value['reasoning'] !== undefined) {
    if (!isRecord(value['reasoning'])) {
      throw new Error('OpenRouter model metadata snapshot reasoning must be an object');
    }
    const reasoning = value['reasoning'];
    const rawReasoning: Record<string, unknown> = {
      mandatory: reasoning['mandatory'],
    };
    rawReasoning['default_effort'] = reasoning['defaultEffort'];
    rawReasoning['default_enabled'] = reasoning['defaultEnabled'];
    rawReasoning['supported_efforts'] = reasoning['supportedEfforts'];
    rawReasoning['supports_max_tokens'] = reasoning['supportsMaxTokens'];
    data['reasoning'] = rawReasoning;
  }
  return parseOpenRouterModelMetadata({ data }, id, checkedAt);
}

export function parseOpenRouterModelMetadataSnapshot(
  value: unknown
): OpenRouterModelMetadataSnapshot {
  if (!isRecord(value)) {
    throw new Error('OpenRouter model metadata snapshot requires an object');
  }
  const freshness = value['freshness'];
  if (!(freshness === 'live' || freshness === 'fresh-cache' || freshness === 'stale-cache')) {
    throw new Error('OpenRouter model metadata snapshot has invalid freshness');
  }
  const metadata = parseSnapshotMetadata(value['metadata']);
  if (freshness !== 'stale-cache') {
    return { freshness, metadata };
  }

  const warning = value['warning'];
  if (
    !(
      typeof warning === 'string' &&
      warning.trim().length > 0 &&
      warning.length <= MAX_WARNING_LENGTH
    )
  ) {
    throw new Error('OpenRouter stale metadata snapshot requires a bounded warning');
  }
  return { freshness, metadata, warning };
}
