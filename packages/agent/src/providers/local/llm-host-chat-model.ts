/**
 * AI SDK v2 language model that proxies built-in local LLM inference to a
 * remote host (desktop: the hidden llm-host renderer, driven from Electron
 * main via `LocalLlmHostClient`).
 *
 * Unlike the in-process `LocalLanguageModel` (which generates fully and then
 * replays parts), this model converts the host's cumulative text/reasoning
 * progress snapshots into REAL incremental `text-delta`/`reasoning-delta`
 * stream parts, so the Mastra loop streams while Gemma is still generating —
 * and those deltas keep the stream inactivity watchdog fed.
 */
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import { createLogger } from '@brainstrike/utils/logger';
import type { LocalProviderOptions } from '../../types';
import type {
  LocalLlmHostClient,
  LocalLlmHostGenerationOptions,
  LocalLlmHostProgress,
} from './llm-host-client';
import {
  buildV2ContentFromResult,
  buildV2UsageFromResult,
  convertPromptToLocalMessages,
  convertToolsFromArray,
  generateStreamPartId,
  mapFinishReason,
} from './local-message-conversion';
import type { LocalLlmGenerationResult, LocalLlmMessage } from './types';

const logger = createLogger('LlmHostChatModel');

export interface LlmHostChatModelSettings {
  maxNewTokens?: number;
  temperature?: number;
  thinking?: LocalProviderOptions['thinking'];
  topK?: number;
  topP?: number;
}

interface PreparedGenerateRequest {
  generateOptions: LocalLlmHostGenerationOptions;
  messages: LocalLlmMessage[];
}

/**
 * Tracks one streamed channel (text or reasoning) fed by cumulative
 * snapshots: opens the part on first content, emits suffix deltas, and
 * reconciles against the final authoritative result text.
 */
class SnapshotChannel {
  private emitted = '';
  private id: string | null = null;

  constructor(
    private readonly kind: 'reasoning' | 'text',
    private readonly controller: ReadableStreamDefaultController<LanguageModelV2StreamPart>
  ) {}

  acceptSnapshot(snapshot: string): void {
    if (!snapshot || snapshot.length <= this.emitted.length) {
      return;
    }
    if (!snapshot.startsWith(this.emitted)) {
      // Snapshots are cumulative outputs of the host's stripping pipeline; a
      // non-prefix snapshot means the host rewrote earlier text. Keep what we
      // emitted (it is what the user saw) and log loudly for diagnosis.
      logger.warn('Local llm host snapshot diverged from emitted prefix; ignoring snapshot', {
        emittedLength: this.emitted.length,
        kind: this.kind,
        snapshotLength: snapshot.length,
      });
      return;
    }
    this.emitDelta(snapshot.slice(this.emitted.length));
    this.emitted = snapshot;
  }

  /** Emit any remainder of the final authoritative text, then close the part. */
  finalize(finalText: string | undefined): void {
    if (finalText && finalText.length > 0) {
      if (finalText.startsWith(this.emitted)) {
        const remainder = finalText.slice(this.emitted.length);
        if (remainder.length > 0) {
          this.emitDelta(remainder);
          this.emitted = finalText;
        }
      } else {
        logger.warn('Local llm host final text diverged from streamed snapshots', {
          emittedLength: this.emitted.length,
          finalLength: finalText.length,
          kind: this.kind,
        });
      }
    }
    this.close();
  }

  close(): void {
    if (this.id === null) {
      return;
    }
    this.controller.enqueue(
      this.kind === 'text'
        ? { id: this.id, type: 'text-end' }
        : { id: this.id, type: 'reasoning-end' }
    );
    this.id = null;
  }

  private emitDelta(delta: string): void {
    if (delta.length === 0) {
      return;
    }
    if (this.id === null) {
      this.id = generateStreamPartId();
      this.controller.enqueue(
        this.kind === 'text'
          ? { id: this.id, type: 'text-start' }
          : { id: this.id, type: 'reasoning-start' }
      );
    }
    this.controller.enqueue(
      this.kind === 'text'
        ? { delta, id: this.id, type: 'text-delta' }
        : { delta, id: this.id, type: 'reasoning-delta' }
    );
  }
}

export class LlmHostChatModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2';
  readonly provider = 'local';
  readonly modelId: string;

  /** Local models don't natively support any URLs - all content must be provided directly. */
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly client: LocalLlmHostClient;
  private readonly settings: LlmHostChatModelSettings;

  constructor(
    modelId: string,
    client: LocalLlmHostClient,
    settings: LlmHostChatModelSettings = {}
  ) {
    this.modelId = modelId;
    this.client = client;
    this.settings = settings;
  }

  doGenerate(
    options: LanguageModelV2CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    return this.executeGenerate(options);
  }

  doStream(
    options: LanguageModelV2CallOptions
  ): PromiseLike<Awaited<ReturnType<LanguageModelV2['doStream']>>> {
    return Promise.resolve(this.executeStream(options));
  }

  private prepareRequest(options: LanguageModelV2CallOptions): PreparedGenerateRequest {
    const messages = convertPromptToLocalMessages(options.prompt);
    const tools = convertToolsFromArray(options.tools);

    const generateOptions: LocalLlmHostGenerationOptions = {
      maxNewTokens: options.maxOutputTokens ?? this.settings.maxNewTokens ?? 512,
    };

    const temperature = options.temperature ?? this.settings.temperature;
    if (temperature !== undefined) {
      generateOptions.temperature = temperature;
    }
    const topP = options.topP ?? this.settings.topP;
    if (topP !== undefined) {
      generateOptions.topP = topP;
    }
    const topK = options.topK ?? this.settings.topK;
    if (topK !== undefined) {
      generateOptions.topK = topK;
    }
    if (tools !== undefined) {
      generateOptions.tools = tools;
    }
    if (this.settings.thinking !== undefined) {
      generateOptions.thinking = this.settings.thinking;
    }

    return { generateOptions, messages };
  }

  private buildRequestMetadata(prepared: PreparedGenerateRequest): {
    body: Record<string, unknown>;
  } {
    return {
      body: {
        maxNewTokens: prepared.generateOptions.maxNewTokens,
        messages: prepared.messages,
        temperature: prepared.generateOptions.temperature,
        topK: prepared.generateOptions.topK,
        topP: prepared.generateOptions.topP,
      },
    };
  }

  private async executeGenerate(
    options: LanguageModelV2CallOptions
  ): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    const prepared = this.prepareRequest(options);

    const result = await this.client.generate(
      {
        messages: prepared.messages,
        modelId: this.modelId,
        options: prepared.generateOptions,
      },
      options.abortSignal ? { signal: options.abortSignal } : {}
    );

    const warnings: LanguageModelV2CallWarning[] = [];
    return {
      content: buildV2ContentFromResult(result),
      finishReason: mapFinishReason(result.finishReason),
      request: this.buildRequestMetadata(prepared),
      usage: buildV2UsageFromResult(result),
      warnings,
    };
  }

  private executeStream(
    options: LanguageModelV2CallOptions
  ): Awaited<ReturnType<LanguageModelV2['doStream']>> {
    const prepared = this.prepareRequest(options);
    const { client, modelId } = this;

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: async (controller) => {
        const textChannel = new SnapshotChannel('text', controller);
        const reasoningChannel = new SnapshotChannel('reasoning', controller);

        controller.enqueue({ type: 'stream-start', warnings: [] });

        const handleProgress = (progress: LocalLlmHostProgress): void => {
          if (progress.kind === 'reasoning' && typeof progress.reasoningText === 'string') {
            reasoningChannel.acceptSnapshot(progress.reasoningText);
            return;
          }
          if (progress.kind === 'text' && typeof progress.text === 'string') {
            // Visible text starting means the reasoning channel is finished.
            reasoningChannel.close();
            textChannel.acceptSnapshot(progress.text);
          }
        };

        let result: LocalLlmGenerationResult;
        try {
          result = await client.generate(
            {
              messages: prepared.messages,
              modelId,
              options: prepared.generateOptions,
            },
            {
              onProgress: handleProgress,
              ...(options.abortSignal ? { signal: options.abortSignal } : {}),
            }
          );
        } catch (error) {
          controller.error(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        reasoningChannel.finalize(result.reasoningText);
        textChannel.finalize(result.text);

        if (result.toolCalls) {
          for (const toolCall of result.toolCalls) {
            controller.enqueue({
              input: toolCall.function.arguments,
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              type: 'tool-call',
            });
          }
        }

        controller.enqueue({
          finishReason: mapFinishReason(result.finishReason),
          type: 'finish',
          usage: buildV2UsageFromResult(result),
        });
        controller.close();
      },
    });

    return {
      request: this.buildRequestMetadata(prepared),
      stream,
    };
  }
}

export function createLlmHostChatModel(
  modelId: string,
  client: LocalLlmHostClient,
  settings?: LlmHostChatModelSettings
): LanguageModelV2 {
  return new LlmHostChatModel(modelId, client, settings);
}
