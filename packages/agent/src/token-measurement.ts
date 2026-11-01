import type { TokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { Predicate } from 'effect';
import { countTokens, readyTokenCounter, TokenCounterUnavailableError } from './token-counter.ts';

const MAX_FAILURE_MESSAGE_CHARACTERS = 240;
const INLINE_MEDIA_TYPES = new Set(['file-data', 'image-data', 'media']);
const URL_MEDIA_TYPES = new Set(['file-url', 'image-url']);

type TokenMeasurementFailureCode = 'counter-execution-failed' | 'counter-initialization-failed';

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
  measure(text: string): Promise<TokenMeasurementSample>;
}

/** Counts one text; a `TokenCounterUnavailableError` reads as the counter's initialization failure. */
export type TokenCounter = (text: string) => Promise<number>;

export interface TokenMeasurementDependencies {
  loadCounter?: (
    tokenizer: Extract<TokenMeasurementCapability, { tokenizer: string }>['tokenizer']
  ) => Promise<TokenCounter | null>;
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

/** The o200k counter runs on its worker thread, never on the caller's (BST-2438). */
async function loadO200kCounter(): Promise<TokenCounter> {
  await readyTokenCounter();
  return countTokens;
}

export async function createPreparedTokenMeasurement(
  capability: TokenMeasurementCapability,
  dependencies: TokenMeasurementDependencies = {}
): Promise<PreparedTokenMeasurement> {
  if (capability.mode === 'deterministic-serialized-character-backstop') {
    return {
      capability,
      measure: async (text) => {
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

  let counter: TokenCounter | null = null;
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
    measure: async (text) => {
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
        const tokenCount = await counter(text);
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
          // A counter whose worker failed or exited is a counter that cannot count.
          failureCode:
            error instanceof TokenCounterUnavailableError
              ? 'counter-initialization-failed'
              : 'counter-execution-failed',
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
    Predicate.isObject(data) &&
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
  if (!Predicate.isObject(value)) {
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
