/**
 * The Hosted Web turn: one AI SDK 7 `streamText` call, mapped onto the
 * {@link StreamChunk} contract `DataStreamMapper` consumes.
 *
 * ADR-0022. This is the whole engine for Hosted Web. There are deliberately no
 * tools, no MCP, no memory, no personas and no storage here: web's allow-list
 * (`apps/web/src/server/web-assistant-runtime-schema.ts`) rejects every one of
 * those fields at the request boundary, so the capability envelope is set
 * there and this module must not widen it.
 *
 * No fallback: a provider error ends the turn visibly. The session wrapper
 * (`stream/data-stream.ts`) turns a thrown error into an error frame, and a
 * stream that ends WITHOUT a terminal `message-finish` is reported as a failed
 * run by `DataStreamMapper.finalizeOnStreamEnd`. Both are loud by design.
 */
import {
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import { buildCurrentDateNote, buildDefaultInstructions } from '../instructions/default-instructions';
import { readOpenRouterBilledCost } from '../usage-metering';
import type { AgentMessage, StreamChunk, StreamFinishReason, StreamIterator } from '../types';

export interface HostedWebTurnParams {
  readonly messages: readonly AgentMessage[];
  /** Resolved by the caller, exactly as the host resolves its own model. */
  readonly model: LanguageModel;
  /** Prompt-assembly clock, injected so the composed instructions stay pure. */
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

export async function streamHostedWebTurn(params: HostedWebTurnParams): Promise<StreamIterator> {
  // AI SDK 7 refuses system entries in `messages` and names `instructions` as
  // their home, so the system preamble (web's workspace root manifest among
  // it) is lifted out in request order rather than passed through.
  const leading = params.messages.findIndex((message) => message.role !== 'system');
  const preamble = leading === -1 ? params.messages : params.messages.slice(0, leading);
  const rest = leading === -1 ? [] : params.messages.slice(leading);
  if (rest.some((message) => message.role === 'system')) {
    // `instructions` is positionless, so hoisting a later system message would
    // quietly move it ahead of the turns it was written to follow. Refuse it
    // rather than reorder the conversation behind the caller's back.
    throw new Error('Hosted Web cannot send a system message after the first turn');
  }
  // Parity with the retired path, which composed these on EVERY hosted turn
  // (agent-runtime.ts:495 and :511). Web registers no tools, so the builder
  // gets an empty name map and degrades to the behaviour rules alone. Order
  // matches the engine: instructions, then the date, then the request's own
  // system preamble (the workspace root manifest).
  const instructions = [
    buildDefaultInstructions(new Map(), {}),
    buildCurrentDateNote(params.now ?? new Date()),
    ...preamble.map(toSystemText),
  ]
    .filter((part) => part.length > 0)
    .join('\n');
  const result = streamText({
    messages: toModelMessages(rest),
    model: params.model,
    ...(instructions ? { instructions } : {}),
    ...(params.signal ? { abortSignal: params.signal } : {}),
  });
  return toStreamChunks(result.fullStream);
}

async function* toStreamChunks(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>
): AsyncGenerator<StreamChunk> {
  // OpenRouter reports its exact charge in the STEP's providerMetadata; the
  // run-level `finish` part carries none. Keeping the provider-authoritative
  // number is the whole reason web still routes through the Mastra model
  // router, so dropping it here would defeat that. `absent` and `malformed`
  // both mean "cost unknown", and unknown is expressed by omitting the field
  // rather than by reporting zero — the same rule agent-streaming.ts:419 uses.
  let billedCostUsd: number | undefined;
  for await (const part of fullStream) {
    switch (part.type) {
      case 'finish-step': {
        const reading = readOpenRouterBilledCost(part);
        if (reading.kind === 'reported') {
          billedCostUsd = (billedCostUsd ?? 0) + reading.usd;
        }
        break;
      }
      case 'text-delta': {
        if (part.text) {
          yield { type: 'text-delta', value: part.text };
        }
        break;
      }
      case 'reasoning-delta': {
        if (part.text) {
          yield { type: 'reasoning-delta', value: part.text };
        }
        break;
      }
      case 'error': {
        throw asError(part.error);
      }
      case 'finish': {
        yield {
          ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
          finishReason: part.finishReason satisfies StreamFinishReason,
          path: [],
          type: 'message-finish',
          usage: toFinishUsage(part.totalUsage),
        };
        break;
      }
      default:
        break;
    }
  }
}

type FinishUsage = Extract<StreamChunk, { type: 'message-finish' }>['usage'];

/**
 * A Hosted Web turn is exactly one provider step, so the step sizes the UI
 * draws context occupancy from are the run totals. Cache tokens ride along
 * because hosted Anthropic caches its prompt prefix (BST-587) and the shared
 * UI runtime bills reads and writes at different rates; they are omitted
 * rather than reported as zero when the provider cached nothing.
 */
function toFinishUsage(usage: LanguageModelUsage): FinishUsage {
  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return {
    ...(cacheWrite > 0 ? { cacheCreationInputTokens: cacheWrite } : {}),
    ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
    completionTokens,
    contextInputTokens: promptTokens,
    contextOutputTokens: completionTokens,
    promptTokens,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
  return messages.map(
    (message) => ({ content: message.parts.map(toContentPart), role: message.role }) as ModelMessage
  );
}

/** System content is a plain string in the SDK's prompt DTO, never a part array. */
function toSystemText(message: AgentMessage): string {
  return message.parts
    .map((part) => {
      if (part.type !== 'text') {
        throw new Error(`Hosted Web cannot send a ${part.type} part in a system message`);
      }
      return part.text;
    })
    .join('\n');
}

function toContentPart(part: AgentMessage['parts'][number]) {
  if (part.type === 'text') {
    return { text: part.text, type: 'text' as const };
  }
  if (part.type === 'file') {
    // The canonical AI SDK ImagePart, as the retired path emitted
    // (agent-runtime.ts:440) — the shape provider adapters convert for vision.
    // A generic `file` part is NOT equivalent: vision routes that do not
    // implement file parts ignore or reject it. This endpoint admits only
    // validated image attachments, so image is always the right shape.
    return { image: part.data, mediaType: part.mediaType, type: 'image' as const };
  }
  // Hosted Web runs no tools, so a tool part cannot have come from a turn this
  // endpoint served. Refuse it rather than drop it on the way to the provider.
  throw new Error(`Hosted Web cannot send a ${part.type} message part to the provider`);
}
