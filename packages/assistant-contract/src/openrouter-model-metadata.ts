export const OPENROUTER_MODEL_METADATA_SOURCE = 'openrouter-models-api' as const;

const MAX_SUPPORTED_PARAMETERS = 64;
const MAX_SUPPORTED_PARAMETER_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_WARNING_LENGTH = 300;

export interface OpenRouterModelMetadata {
  readonly checkedAt: number;
  readonly contextWindow: number;
  readonly id: string;
  readonly maxOutputTokens?: number;
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

  const contextWindow = requirePositiveInteger(data['context_length'], 'context_length');
  const supportedParameters = parseSupportedParameters(data['supported_parameters']);
  const topProvider = data['top_provider'];
  if (!isRecord(topProvider)) {
    throw new Error('OpenRouter model metadata requires a top_provider object');
  }

  const rawMaxOutputTokens = topProvider['max_completion_tokens'];
  if (rawMaxOutputTokens === undefined || rawMaxOutputTokens === null) {
    return {
      checkedAt,
      contextWindow,
      id: expectedModelId,
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
  const topProvider: Record<string, unknown> = {};
  if (value['maxOutputTokens'] !== undefined) {
    topProvider['max_completion_tokens'] = value['maxOutputTokens'];
  }
  const data: Record<string, unknown> = { id };
  data['context_length'] = value['contextWindow'];
  data['supported_parameters'] = value['supportedParameters'];
  data['top_provider'] = topProvider;
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
