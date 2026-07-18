import type { MastraDBMessage } from '@mastra/core/agent';
import {
  type ProcessInputStepArgs,
  type Processor,
  TokenLimiter,
  type TokenLimiterOptions,
} from '@mastra/core/processors';

interface MutableToolInvocation {
  result?: unknown;
  state?: unknown;
}

interface ResultReplacement {
  readonly descriptor: PropertyDescriptor | undefined;
  readonly invocation: MutableToolInvocation;
}

const MODEL_OUTPUT_MEDIA_TYPES = new Set(['file-data', 'image-data', 'image-url', 'media']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function buildMediaMarker(part: Record<string, unknown>): Record<string, string> {
  const mediaType =
    typeof part['mediaType'] === 'string' && part['mediaType'].length > 0
      ? part['mediaType']
      : 'unknown';
  return {
    text: `[${String(part['type'])} payload omitted from token count; media type: ${mediaType}]`,
    type: 'text',
  };
}

function compactMediaForTokenCounting(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactMediaForTokenCounting);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (typeof value['type'] === 'string' && MODEL_OUTPUT_MEDIA_TYPES.has(value['type'])) {
    return buildMediaMarker(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compactMediaForTokenCounting(entry)])
  );
}

function readStoredModelOutput(message: MastraDBMessage): Array<{
  invocation: MutableToolInvocation;
  modelOutput: unknown;
}> {
  const outputs: Array<{ invocation: MutableToolInvocation; modelOutput: unknown }> = [];

  for (const part of message.content.parts) {
    if (part.type !== 'tool-invocation' || part.toolInvocation.state !== 'result') {
      continue;
    }
    const mastraMetadata = part.providerMetadata?.['mastra'];
    if (!(isRecord(mastraMetadata) && Object.hasOwn(mastraMetadata, 'modelOutput'))) {
      continue;
    }
    outputs.push({
      invocation: part.toolInvocation,
      modelOutput: mastraMetadata['modelOutput'],
    });
  }

  return outputs;
}

/**
 * Runs Mastra's TokenLimiter against each tool's persisted model projection.
 *
 * Mastra stores the raw tool result in `toolInvocation.result` and the compact
 * provider-facing value in `providerMetadata.mastra.modelOutput`. TokenLimiter
 * 1.51 counts the former directly, before prompt conversion applies the latter.
 * This processor temporarily swaps in the projection solely for token counting,
 * then restores the exact raw property descriptor even when the limiter throws.
 */
export class ProjectionAwareTokenLimiter implements Processor<'token-limiter'> {
  readonly id = 'token-limiter';
  readonly name = 'Token Limiter';
  readonly #limiter: TokenLimiter;

  constructor(options: number | TokenLimiterOptions) {
    this.#limiter = new TokenLimiter(options);
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<void> {
    const replacements: ResultReplacement[] = [];

    try {
      for (const message of args.messageList.get.all.db()) {
        for (const { invocation, modelOutput } of readStoredModelOutput(message)) {
          const descriptor = Object.getOwnPropertyDescriptor(invocation, 'result');
          replacements.push({ descriptor, invocation });
          Object.defineProperty(invocation, 'result', {
            configurable: true,
            enumerable: descriptor?.enumerable ?? true,
            value: compactMediaForTokenCounting(modelOutput),
            writable: true,
          });
        }
      }

      await this.#limiter.processInputStep(args);
    } finally {
      for (const { descriptor, invocation } of replacements.reverse()) {
        if (descriptor) {
          Object.defineProperty(invocation, 'result', descriptor);
          continue;
        }
        Reflect.deleteProperty(invocation, 'result');
      }
    }
  }

  getMaxTokens(): number {
    return this.#limiter.getMaxTokens();
  }
}
