import type { ProviderModelConfiguration } from '@brainstrike/agent/provider-runtime';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { type LanguageModel, wrapLanguageModel } from 'ai';

type SdkV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>;
type StreamResult = Awaited<ReturnType<SdkV3['doStream']>>;
type GenerateResult = Awaited<ReturnType<SdkV3['doGenerate']>>;
type Part = StreamResult['stream'] extends ReadableStream<infer Value> ? Value : never;
type Content = GenerateResult['content'][number];
type TextContent = Extract<Content, { type: 'text' | 'reasoning' }>;

/** Preserve the pinned router's actual V3/V4 finish DTO, including raw usage and cost. */
function streamResult(
  result: Awaited<ReturnType<ModelRouterLanguageModel['doStream']>>
): StreamResult {
  // The router declares V2 but its pinned V3/V4 wrappers return their underlying
  // stream DTO unchanged. Intercepted OpenRouter and compatible-server receipts
  // qualify this boundary; the public SDK wrapper subsequently handles V3 -> V4.
  // https://github.com/mastra-ai/mastra/tree/main/packages/core/src/llm/model/aisdk
  // Remove this declaration bridge when the public router reports its actual DTO.
  return {
    ...result,
    stream: (result.stream as unknown as StreamResult['stream']).pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, controller) {
          if (
            part.type === 'finish' &&
            (typeof part.finishReason !== 'object' ||
              typeof part.usage.inputTokens !== 'object' ||
              typeof part.usage.outputTokens !== 'object')
          ) {
            throw new Error('The configured router returned an unqualified SDK result shape');
          }
          controller.enqueue(part);
        },
      })
    ),
  };
}

class RouterGenerationCollector {
  private readonly content: Content[] = [];
  private readonly blocks = new Map<string, TextContent>();
  private readonly completedCalls = new Set<string>();
  private readonly pendingInputs = new Set<string>();
  private finish: Extract<Part, { type: 'finish' }> | undefined;
  private response: GenerateResult['response'];
  private readonly warnings: GenerateResult['warnings'] = [];

  constructor(private readonly source: StreamResult) {
    this.response = source.response;
  }

  private startBlock(part: Extract<Part, { type: 'text-start' | 'reasoning-start' }>): void {
    const key = `${part.type}:${part.id}`;
    if (this.blocks.has(key)) {
      throw new Error('Router content block was started twice');
    }
    const value: TextContent = {
      text: '',
      type: part.type === 'text-start' ? 'text' : 'reasoning',
      ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
    };
    this.blocks.set(key, value);
    this.content.push(value);
  }

  private updateBlock(
    part: Extract<Part, { type: 'text-delta' | 'reasoning-delta' | 'text-end' | 'reasoning-end' }>
  ): void {
    const kind = part.type.startsWith('text') ? 'text' : 'reasoning';
    const key = `${kind}-start:${part.id}`;
    const block = this.blocks.get(key);
    if (!block) {
      throw new Error('Router content has no open block');
    }
    if ('delta' in part) {
      block.text += part.delta;
    }
    if (part.providerMetadata) {
      block.providerMetadata = { ...block.providerMetadata, ...part.providerMetadata };
    }
    if (part.type.endsWith('-end')) {
      this.blocks.delete(key);
    }
  }

  private finishCall(part: Extract<Part, { type: 'tool-call' }>): void {
    if (this.completedCalls.has(part.toolCallId)) {
      throw new Error('Router completed a tool call twice');
    }
    this.completedCalls.add(part.toolCallId);
    this.pendingInputs.delete(part.toolCallId);
    this.content.push(part);
  }

  accept(part: Part): void {
    switch (part.type) {
      case 'text-start':
      case 'reasoning-start':
        this.startBlock(part);
        break;
      case 'text-delta':
      case 'reasoning-delta':
      case 'text-end':
      case 'reasoning-end':
        this.updateBlock(part);
        break;
      case 'tool-input-start':
        this.pendingInputs.add(part.id);
        break;
      case 'tool-input-delta':
      case 'tool-input-end':
        break;
      case 'tool-call':
        this.finishCall(part);
        break;
      case 'tool-result':
      case 'file':
      case 'source':
      case 'tool-approval-request':
        this.content.push(part);
        break;
      case 'response-metadata': {
        const { type: _type, ...metadata } = part;
        this.response = { ...this.response, ...metadata };
        break;
      }
      case 'stream-start':
        this.warnings.push(...part.warnings);
        break;
      case 'finish':
        if (this.finish) {
          throw new Error('Router generation finished twice');
        }
        this.finish = part;
        break;
      case 'error':
        throw part.error;
      case 'raw':
        break;
    }
  }

  complete(): GenerateResult {
    const finish = this.finish;
    if (!finish || this.blocks.size > 0 || this.pendingInputs.size > 0) {
      throw new Error('Router generation ended without complete content and finish metadata');
    }
    return {
      content: this.content,
      finishReason: finish.finishReason,
      usage: finish.usage,
      warnings: this.warnings,
      ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
      ...(this.source.request ? { request: this.source.request } : {}),
      ...(this.response ? { response: this.response } : {}),
    };
  }
}

/** Collect the router's non-streaming method, without invoking its streaming provider method. */
export async function collectRouterGenerateResult(
  result: StreamResult,
  signal?: AbortSignal
): Promise<GenerateResult> {
  const reader = result.stream.getReader();
  const collector = new RouterGenerationCollector(result);
  let cancellation: Promise<void> | undefined;
  const abort = (): void => {
    cancellation ??= reader.cancel(signal?.reason);
    cancellation.catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  try {
    for (;;) {
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) {
        break;
      }
      collector.accept(item.value);
    }
    return collector.complete();
  } catch (cause) {
    try {
      cancellation ??= reader.cancel(cause);
      await cancellation;
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Router generation and source cleanup failed');
    }
    throw cause;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Keep the shipped router's auth, request routing, strict-content and cost behavior. */
export function materializeHostProviderModel(
  configuration: ProviderModelConfiguration
): ReturnType<typeof wrapLanguageModel> {
  let model: ModelRouterLanguageModel;
  if ('gatewayId' in configuration) {
    model = configuration;
  } else if ('doStream' in configuration) {
    return wrapLanguageModel({ middleware: { specificationVersion: 'v4' }, model: configuration });
  } else {
    model = new ModelRouterLanguageModel(configuration);
  }
  const facade: SdkV3 = {
    doGenerate: async (options) =>
      collectRouterGenerateResult(
        streamResult(
          await model.doGenerate(
            options as unknown as Parameters<ModelRouterLanguageModel['doGenerate']>[0]
          )
        ),
        options.abortSignal
      ),
    doStream: async (options) =>
      streamResult(
        await model.doStream(
          // The pinned public router remaps its V2 prompt/tool DTO into the selected
          // V3 provider. SDK 7's public wrapper supplies the compatible V3 input here.
          options as unknown as Parameters<ModelRouterLanguageModel['doStream']>[0]
        )
      ),
    modelId: model.modelId,
    provider: model.provider,
    specificationVersion: 'v3',
    supportedUrls: model.supportedUrls,
  };
  return wrapLanguageModel({ middleware: { specificationVersion: 'v4' }, model: facade });
}
