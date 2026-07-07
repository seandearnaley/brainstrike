import { createLogger } from '@brainstrike/utils/logger';
import {
  resolveLocalArtifactRemoteHost,
  resolveLocalArtifactRemotePathTemplate,
} from './local-artifact-store';
import type { LocalLlmModelSpec } from './local-model-specs';
import type {
  LocalLlmGenerationOptions,
  LocalLlmMessage,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
} from './types';

const logger = createLogger('Gemma4Engine');

interface ProgressInfo {
  file?: string;
  loaded?: number;
  progress?: number;
  status: string;
  total?: number;
}

interface TokenizerLike {
  decode: (tokens: readonly bigint[], options: GemmaDecodeOptions) => string;
  encode: (text: string) => { length: number } | readonly unknown[];
  raw: unknown;
}

interface TensorLike {
  dims: number[];
}

interface ProcessorInputs extends Record<string, unknown> {
  inputIds: TensorLike;
}

interface GemmaTemplateOptions {
  addGenerationPrompt: boolean;
  enableThinking: boolean;
  tools?: readonly LocalLlmToolDefinition[];
}

interface GemmaDecodeOptions {
  skipSpecialTokens: boolean;
}

interface GemmaProcessorRunOptions {
  addSpecialTokens: boolean;
}

interface GemmaProcessorBase {
  applyChatTemplate: (
    messages: readonly GemmaChatMessage[],
    options: GemmaTemplateOptions
  ) => string;
  batchDecode: (tokens: unknown, options: GemmaDecodeOptions) => string[];
  run: (
    prompt: string,
    images: unknown,
    audio: unknown,
    options: GemmaProcessorRunOptions
  ) => Promise<ProcessorInputs>;
  tokenizer: TokenizerLike;
}

type LoadedGemmaProcessor = GemmaProcessorBase;

interface GemmaModel {
  dispose?: () => Promise<void>;
  generate: (inputs: Record<string, unknown>) => Promise<{
    slice: (start: null, range: [number, null]) => unknown;
  }>;
}

interface LoaderOptions {
  progressCallback?: (progress: ProgressInfo) => void;
  revision?: string;
}

interface ModelLoaderOptions extends LoaderOptions {
  device: 'webgpu';
  dtype: 'q4f16';
}

interface TransformersModule {
  createTextStreamer: (tokenizer: unknown, options: StreamerOptions) => GemmaTextStreamer;
  loadModel: (modelId: string, options: ModelLoaderOptions) => Promise<GemmaModel>;
  loadProcessor: (modelId: string, options?: LoaderOptions) => Promise<LoadedGemmaProcessor>;
}

interface TransformersEnvironmentLike {
  allowRemoteModels?: boolean;
  remoteHost?: string;
  remotePathTemplate?: string;
}

export function configureTransformersEnvironment(environment: TransformersEnvironmentLike): void {
  environment.allowRemoteModels = true;
  environment.remoteHost = resolveLocalArtifactRemoteHost();
  environment.remotePathTemplate = resolveLocalArtifactRemotePathTemplate();
}

let cachePurged = false;

async function purgeStaleTransformersCache(): Promise<void> {
  if (cachePurged || typeof caches === 'undefined') {
    return;
  }
  cachePurged = true;
  let cache: Cache;
  try {
    cache = await caches.open('transformers-cache');
  } catch {
    return;
  }
  const keys = await cache.keys();
  let purged = 0;
  for (const request of keys) {
    const response = await cache.match(request);
    const contentType = response?.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      await cache.delete(request);
      purged += 1;
    }
  }
  if (purged > 0) {
    logger.info('Purged stale HTML entries from transformers-cache', { purged });
  }
}

interface StreamerOptions {
  callbackFunction?: (text: string) => void;
  skipPrompt?: boolean;
  skipSpecialTokens?: boolean;
  tokenCallbackFunction?: (tokens: readonly bigint[]) => void;
}

interface GemmaTextStreamer {
  ['callback_function']?: (text: string) => void;
}

interface CallableDiagnostics {
  constructorName: string | null;
  hasApply: boolean;
  hasBind: boolean;
  ownKeys: string[];
  prototypeConstructorName: string | null;
  type: string;
}

export interface Gemma4GenerateResult {
  promptText: string;
  rawText: string;
  reasoningText?: string;
  text: string;
  toolCalls: LocalLlmToolCall[];
  usage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
}

interface GemmaChatMessage {
  content?: string;
  role: 'assistant' | 'system' | 'tool' | 'user';
  [key: string]: unknown;
}

function isTensorLike(value: unknown): value is TensorLike {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'dims' in value &&
      Array.isArray((value as Record<string, unknown>)['dims'])
  );
}

function buildLoaderOptions(options?: LoaderOptions): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  if (options?.revision) {
    normalized['revision'] = options.revision;
  }
  if (options?.progressCallback) {
    normalized['progress_callback'] = options.progressCallback;
  }
  return normalized;
}

function buildModelLoaderOptions(options: ModelLoaderOptions): Record<string, unknown> {
  const normalized = buildLoaderOptions(options);
  normalized['device'] = options.device;
  normalized['dtype'] = options.dtype;
  return normalized;
}

function buildTemplateOptions(options: GemmaTemplateOptions): Record<string, unknown> {
  return {
    ['add_generation_prompt']: options.addGenerationPrompt,
    ['enable_thinking']: options.enableThinking,
    ...(options.tools ? { tools: options.tools } : {}),
  };
}

function buildDecodeOptions(options: GemmaDecodeOptions): Record<string, unknown> {
  return {
    ['skip_special_tokens']: options.skipSpecialTokens,
  };
}

function buildProcessorRunOptions(options: GemmaProcessorRunOptions): Record<string, unknown> {
  return {
    ['add_special_tokens']: options.addSpecialTokens,
  };
}

function buildStreamerOptions(options: StreamerOptions): Record<string, unknown> {
  return {
    ['callback_function']: options.callbackFunction,
    ['skip_prompt']: options.skipPrompt ?? true,
    ['skip_special_tokens']: options.skipSpecialTokens ?? false,
    ...(options.tokenCallbackFunction
      ? { ['token_callback_function']: options.tokenCallbackFunction }
      : {}),
  };
}

function buildGenerateOptions(options: LocalLlmGenerationOptions): Record<string, unknown> {
  return {
    ['do_sample']: options.doSample ?? false,
    ['max_new_tokens']: options.maxNewTokens ?? 512,
    temperature: options.temperature ?? 1.0,
    ['top_k']: options.topK ?? 64,
    ['top_p']: options.topP ?? 0.95,
  };
}

function getRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function getOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getOptionalProperty(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  try {
    return getOptionalRecord(Reflect.get(value, key));
  } catch {
    return null;
  }
}

function getConstructorName(value: unknown): string | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }
  const valueConstructor = (value as { constructor?: { name?: unknown } }).constructor;
  return typeof valueConstructor?.name === 'string' ? valueConstructor.name : null;
}

function describeCallable(value: unknown): CallableDiagnostics {
  const ownKeys =
    value && (typeof value === 'object' || typeof value === 'function')
      ? Object.keys(value as Record<string, unknown>).slice(0, 10)
      : [];
  const prototype = value ? Object.getPrototypeOf(value) : null;
  return {
    constructorName: getConstructorName(value),
    hasApply: Boolean(
      value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof Reflect.get(value as Record<string, unknown>, 'apply') === 'function'
    ),
    hasBind: Boolean(
      value &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof Reflect.get(value as Record<string, unknown>, 'bind') === 'function'
    ),
    ownKeys,
    prototypeConstructorName: getConstructorName(prototype),
    type: typeof value,
  };
}

function invokeCallable(
  value: unknown,
  thisArg: unknown,
  args: readonly unknown[],
  label: string
): unknown {
  if (typeof value !== 'function') {
    throw new Error(`${label} is invalid`);
  }

  try {
    return Function.prototype.apply.call(value, thisArg, args);
  } catch (error) {
    logger.error('Gemma callable invocation failed', {
      argsCount: args.length,
      diagnostics: describeCallable(value),
      error: error instanceof Error ? error.message : String(error),
      label,
      thisArgConstructorName: getConstructorName(thisArg),
      ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack } : {}),
    });
    throw error;
  }
}

function getCallable(
  owner: Record<string, unknown>,
  key: string,
  label: string
): (...args: unknown[]) => unknown {
  const candidate = owner[key];
  if (typeof candidate !== 'function') {
    throw new Error(`${label} is invalid`);
  }
  return (...args: unknown[]) => invokeCallable(candidate, owner, args, label);
}

function bindCallable(value: unknown, label: string): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(`${label} is invalid`);
  }
  return (...args: unknown[]) => invokeCallable(value, undefined, args, label);
}

function normalizeProcessorInputs(value: unknown): ProcessorInputs {
  const candidate = getRecord(value, 'Gemma processor inputs');
  const inputIds = candidate['input_ids'] ?? candidate['inputIds'];
  if (!isTensorLike(inputIds)) {
    throw new Error('Gemma processor inputs are missing input_ids');
  }
  return {
    ...candidate,
    inputIds,
  };
}

function normalizeGemmaProcessor(value: unknown): LoadedGemmaProcessor {
  const candidate = getRecord(value, 'Gemma processor');
  const applyChatTemplate = getCallable(candidate, 'apply_chat_template', 'Gemma processor');
  const batchDecode = getCallable(candidate, 'batch_decode', 'Gemma processor');
  const run =
    typeof value === 'function'
      ? bindCallable(value, 'Gemma processor')
      : getCallable(candidate, 'call', 'Gemma processor');
  const tokenizerCandidate = candidate['tokenizer'];
  const tokenizerRecord = getRecord(tokenizerCandidate, 'Gemma tokenizer');
  const encode = getCallable(tokenizerRecord, 'encode', 'Gemma tokenizer');
  const decode = getCallable(tokenizerRecord, 'decode', 'Gemma tokenizer');

  const tokenizer: TokenizerLike = {
    decode: (tokens: readonly bigint[], options: GemmaDecodeOptions) =>
      decode(tokens, buildDecodeOptions(options)) as string,
    encode: (text: string) =>
      (encode as (textValue: string) => { length: number } | readonly unknown[])(text),
    raw: tokenizerCandidate,
  };

  return {
    applyChatTemplate: (messages, options) =>
      applyChatTemplate(messages, buildTemplateOptions(options)) as string,
    batchDecode: (tokens, options) => batchDecode(tokens, buildDecodeOptions(options)) as string[],
    run: async (prompt, images, audio, options) =>
      normalizeProcessorInputs(await run(prompt, images, audio, buildProcessorRunOptions(options))),
    tokenizer,
  };
}

function normalizeGemmaModel(value: unknown): GemmaModel {
  const candidate = getRecord(value, 'Gemma model');
  const generate = getCallable(candidate, 'generate', 'Gemma model');
  const dispose = candidate['dispose'];
  const normalizedModel: GemmaModel = {
    generate: async (inputs: Record<string, unknown>) =>
      (await generate(inputs)) as {
        slice: (start: null, range: [number, null]) => unknown;
      },
  };
  if (typeof dispose === 'function') {
    normalizedModel.dispose = async () => {
      await (Function.prototype.apply.call(dispose, candidate, []) as Promise<void>);
    };
  }
  return normalizedModel;
}

async function getTransformersModule(): Promise<TransformersModule> {
  await purgeStaleTransformersCache();
  const mod: unknown = await import(/* @vite-ignore */ '@huggingface/transformers');
  const candidate = getRecord(mod, 'Transformers.js module');
  const envCandidate = getOptionalProperty(candidate, 'env');
  if (envCandidate) {
    configureTransformersEnvironment(envCandidate as TransformersEnvironmentLike);
  }
  const autoProcessor = getRecord(candidate['AutoProcessor'], 'Transformers.js AutoProcessor');
  const textStreamer = candidate['TextStreamer'];
  const gemma4ForCausalLm = getOptionalProperty(candidate, 'Gemma4ForCausalLM');
  const gemma4ForConditionalGeneration = getOptionalProperty(
    candidate,
    'Gemma4ForConditionalGeneration'
  );
  const gemma4 = gemma4ForCausalLm ?? gemma4ForConditionalGeneration;
  if (!gemma4) {
    logger.error('Gemma transformers surface missing model loaders', {
      exportedKeys: Object.keys(candidate)
        .filter((key) => key.toLowerCase().includes('gemma4') || key === 'AutoProcessor')
        .slice(0, 20),
    });
    throw new Error('Transformers.js Gemma4ForCausalLM/Gemma4ForConditionalGeneration is invalid');
  }
  logger.info('Gemma transformers surface resolved', {
    autoProcessor: describeCallable(autoProcessor),
    gemma4Loader: describeCallable(gemma4),
    selectedLoader: gemma4ForCausalLm ? 'Gemma4ForCausalLM' : 'Gemma4ForConditionalGeneration',
  });
  const loadProcessor = getCallable(
    autoProcessor,
    'from_pretrained',
    'Transformers.js AutoProcessor.from_pretrained'
  );
  const loadModel = getCallable(
    gemma4,
    'from_pretrained',
    'Transformers.js Gemma4ForCausalLM.from_pretrained'
  );
  if (typeof textStreamer !== 'function') {
    throw new Error('Transformers.js TextStreamer is invalid');
  }

  return {
    createTextStreamer: (tokenizer, options) =>
      new (
        textStreamer as new (
          tokenizerValue: unknown,
          opts: Record<string, unknown>
        ) => GemmaTextStreamer
      )(tokenizer, buildStreamerOptions(options)),
    loadModel: async (modelId, options) =>
      normalizeGemmaModel(await loadModel(modelId, buildModelLoaderOptions(options))),
    loadProcessor: async (modelId, options) =>
      normalizeGemmaProcessor(await loadProcessor(modelId, buildLoaderOptions(options))),
  };
}

function normalizeToolCallArguments(argumentsText: string): Record<string, unknown> | string {
  try {
    return JSON.parse(argumentsText) as Record<string, unknown>;
  } catch {
    return argumentsText;
  }
}

function injectGemmaSystemMessages(
  messages: readonly LocalLlmMessage[]
): readonly GemmaChatMessage[] {
  const normalized: GemmaChatMessage[] = [];

  for (const message of messages) {
    const role =
      message.role === 'assistant'
        ? 'assistant'
        : message.role === 'user'
          ? 'user'
          : message.role === 'tool'
            ? 'tool'
            : 'system';
    const chatMessage: GemmaChatMessage = { role };
    if (message.content.trim().length > 0) {
      chatMessage.content = message.content;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      chatMessage['tool_calls'] = message.toolCalls.map((toolCall) => ({
        function: {
          arguments: normalizeToolCallArguments(toolCall.function.arguments),
          name: toolCall.function.name,
        },
        type: 'function',
      }));
    }
    if (message.toolResponses && message.toolResponses.length > 0) {
      chatMessage['tool_responses'] = message.toolResponses.map((toolResponse) => ({
        name: toolResponse.name,
        response: toolResponse.response,
      }));
    }
    normalized.push(chatMessage);
  }

  return normalized;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function buildReasoningSplit(
  reasoningText: string,
  text: string
): { reasoningText?: string; text: string } {
  const normalizedReasoning = normalizeWhitespace(reasoningText);
  return {
    ...(normalizedReasoning ? { reasoningText: normalizedReasoning } : {}),
    text: normalizeWhitespace(stripGemmaControlTokens(text)),
  };
}

const GEMMA_THOUGHT_CHANNEL_PREFIXES = [
  '<|channel|>thought\n',
  '<|channel>thought\n',
  '<|channel|>thought ',
  '<|channel>thought ',
  '<|channel|>thought',
  '<|channel>thought',
] as const;
const GEMMA_THOUGHT_CHANNEL_SUFFIXES = ['<channel|>', '<|channel|>'] as const;
const GEMMA_TURN_MARKERS = ['<turn|>', '<|turn|>'] as const;
const GEMMA_EOS_MARKERS = ['</eos>', '<eos>', '<eos/>', '<eos />', '</s>', '<|eos|>'] as const;
const GEMMA_TOOL_CALL_BOUNDARIES = [
  { close: '<tool_call|>', open: '<|tool_call>' },
  { close: '<tool_call|>', open: '<|tool_call|>' },
  { close: '</tool_call>', open: '<tool_call>' },
] as const;

function stripGemmaControlTokens(text: string): string {
  const markers = [...GEMMA_TURN_MARKERS, ...GEMMA_EOS_MARKERS];
  return markers.reduce((result, marker) => result.split(marker).join(''), text).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripGemmaToolCallBlocks(text: string): string {
  let result = text;
  for (const boundary of GEMMA_TOOL_CALL_BOUNDARIES) {
    const blockPattern = new RegExp(
      `${escapeRegExp(boundary.open)}[\\s\\S]*?${escapeRegExp(boundary.close)}`,
      'g'
    );
    result = result.replace(blockPattern, '');
  }
  return result.trim();
}

function findBoundaryAtStart(text: string, boundaries: readonly string[]): string | null {
  for (const boundary of boundaries) {
    if (text.startsWith(boundary)) {
      return boundary;
    }
  }
  return null;
}

function hasPartialBoundaryPrefix(text: string, boundaries: readonly string[]): boolean {
  return boundaries.some((boundary) => boundary.startsWith(text));
}

function findBoundaryInText(
  text: string,
  boundaries: readonly string[]
): { boundary: string; index: number } | null {
  let earliestIndex = Number.POSITIVE_INFINITY;
  let earliestBoundary: string | null = null;

  for (const boundary of boundaries) {
    const index = text.indexOf(boundary);
    if (index >= 0 && index < earliestIndex) {
      earliestIndex = index;
      earliestBoundary = boundary;
    }
  }

  return earliestBoundary ? { boundary: earliestBoundary, index: earliestIndex } : null;
}

function getBoundaryOverlap(text: string, boundaries: readonly string[]): number {
  let maxOverlap = 0;
  for (const boundary of boundaries) {
    const maxLength = Math.min(text.length, boundary.length - 1);
    for (let length = maxLength; length > maxOverlap; length -= 1) {
      if (text.slice(-length) === boundary.slice(0, length)) {
        maxOverlap = length;
        break;
      }
    }
  }
  return maxOverlap;
}

function splitAnswerFromReasoningBlock(text: string): { reasoningText?: string; text: string } {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return { text: '' };
  }

  for (const prefix of GEMMA_THOUGHT_CHANNEL_PREFIXES) {
    const prefixIndex = normalized.indexOf(prefix);
    if (prefixIndex < 0) {
      continue;
    }
    const remainder = normalized.slice(prefixIndex + prefix.length);
    const suffixMatch = findBoundaryInText(remainder, GEMMA_THOUGHT_CHANNEL_SUFFIXES);
    if (!suffixMatch) {
      continue;
    }
    const answerPrefix = normalized.slice(0, prefixIndex);
    const answerSuffix = remainder.slice(suffixMatch.index + suffixMatch.boundary.length);
    return buildReasoningSplit(
      remainder.slice(0, suffixMatch.index),
      `${answerPrefix}${answerSuffix}`
    );
  }

  return { text: stripGemmaControlTokens(normalized) };
}

function parseGemmaStructuredToolCalls(text: string): LocalLlmToolCall[] {
  const toolCalls: LocalLlmToolCall[] = [];

  for (const boundary of GEMMA_TOOL_CALL_BOUNDARIES) {
    const iterator = new RegExp(
      `${escapeRegExp(boundary.open)}([\\s\\S]*?)${escapeRegExp(boundary.close)}`,
      'g'
    );

    for (const match of text.matchAll(iterator)) {
      const payload = match[1]?.trim();
      if (!payload) {
        continue;
      }

      const nameMatch = payload.match(/call:([^{]+)/);
      const functionName = nameMatch?.[1]?.trim();
      const extractedArgumentsText = extractBalancedJsonObject(payload);
      if (!(functionName && extractedArgumentsText)) {
        continue;
      }

      const normalizedArgumentsText = extractedArgumentsText.replace(/<\|"\|>/g, '"');
      const normalizedQuotedArgumentsText = quoteUnquotedJsonKeys(normalizedArgumentsText);

      let argumentsText = normalizedQuotedArgumentsText;
      try {
        argumentsText = JSON.stringify(JSON.parse(normalizedQuotedArgumentsText) as unknown);
      } catch (error) {
        logger.warn('Gemma tool call arguments could not be normalized as JSON', {
          error: error instanceof Error ? error.message : String(error),
          functionName,
          normalizedArgumentsText: normalizedQuotedArgumentsText,
        });
      }

      toolCalls.push({
        function: {
          arguments: argumentsText,
          name: functionName,
        },
        id: crypto.randomUUID(),
        type: 'function',
      });
    }
  }

  return toolCalls;
}

interface JsonKeyQuotingState {
  index: number;
  inString: boolean;
  isEscaped: boolean;
  normalized: string;
}

function quoteUnquotedJsonKeys(text: string): string {
  const state: JsonKeyQuotingState = {
    index: 0,
    inString: false,
    isEscaped: false,
    normalized: '',
  };

  while (state.index < text.length) {
    if (consumeQuotedStringCharacter(text, state)) {
      continue;
    }

    if (consumeStringDelimiter(text, state)) {
      continue;
    }

    if (consumePotentialJsonKey(text, state)) {
      continue;
    }

    const character = text[state.index];
    if (character === undefined) {
      break;
    }
    state.normalized += character;
    state.index += 1;
  }

  return state.normalized;
}

function consumeQuotedStringCharacter(text: string, state: JsonKeyQuotingState): boolean {
  if (!state.inString) {
    return false;
  }

  const character = text[state.index];
  if (character === undefined) {
    return false;
  }

  state.normalized += character;
  if (state.isEscaped) {
    state.isEscaped = false;
  } else if (character === '\\') {
    state.isEscaped = true;
  } else if (character === '"') {
    state.inString = false;
  }
  state.index += 1;
  return true;
}

function consumeStringDelimiter(text: string, state: JsonKeyQuotingState): boolean {
  if (text[state.index] !== '"') {
    return false;
  }

  state.inString = true;
  state.normalized += '"';
  state.index += 1;
  return true;
}

function consumePotentialJsonKey(text: string, state: JsonKeyQuotingState): boolean {
  const leadingCharacter = text[state.index];
  if (!(leadingCharacter === '{' || leadingCharacter === ',')) {
    return false;
  }

  state.normalized += leadingCharacter;
  state.index += 1;
  consumeWhitespace(text, state);

  const keyStart = state.index;
  if (!/[A-Za-z_]/u.test(text[keyStart] ?? '')) {
    return true;
  }

  state.index += 1;
  while (state.index < text.length && /\w/u.test(text[state.index] ?? '')) {
    state.index += 1;
  }

  if (hasJsonKeyColon(text, state.index)) {
    state.normalized += `"${text.slice(keyStart, state.index)}"`;
    return true;
  }

  state.normalized += text.slice(keyStart, state.index);
  return true;
}

function consumeWhitespace(text: string, state: JsonKeyQuotingState): void {
  while (state.index < text.length && /\s/u.test(text[state.index] ?? '')) {
    state.normalized += text[state.index];
    state.index += 1;
  }
}

function hasJsonKeyColon(text: string, index: number): boolean {
  let lookahead = index;
  while (lookahead < text.length && /\s/u.test(text[lookahead] ?? '')) {
    lookahead += 1;
  }
  return text[lookahead] === ':';
}

function extractBalancedJsonObject(text: string): string | null {
  const startIndex = text.indexOf('{');
  if (startIndex < 0) {
    return null;
  }

  const state: {
    depth: number;
    inString: boolean;
    isEscaped: boolean;
  } = {
    depth: 0,
    inString: false,
    isEscaped: false,
  };

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      return null;
    }

    if (advanceJsonStringState(state, character)) {
      continue;
    }

    if (character === '"') {
      state.inString = true;
      continue;
    }

    if (character === '{') {
      state.depth += 1;
      continue;
    }

    if (character === '}') {
      state.depth -= 1;
      if (state.depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function advanceJsonStringState(
  state: {
    depth: number;
    inString: boolean;
    isEscaped: boolean;
  },
  character: string
): boolean {
  if (!state.inString) {
    return false;
  }

  if (state.isEscaped) {
    state.isEscaped = false;
    return true;
  }

  if (character === '\\') {
    state.isEscaped = true;
    return true;
  }

  if (character === '"') {
    state.inString = false;
  }
  return true;
}

class Gemma4StreamAccumulator {
  private answer = '';
  private mode: 'answer' | 'detect' | 'reasoning' = 'detect';
  private pending = '';
  private reasoning = '';

  constructor(thinkingEnabled: boolean) {
    if (!thinkingEnabled) {
      this.mode = 'answer';
    }
  }

  append(chunk: string): { reasoningText?: string; text: string } {
    if (!chunk) {
      return this.snapshot();
    }

    this.pending += chunk;

    while (this.pending.length > 0) {
      if (this.mode === 'detect') {
        if (!this.consumeDetectMode()) {
          break;
        }
        continue;
      }

      if (this.mode === 'reasoning') {
        if (!this.consumeReasoningMode()) {
          break;
        }
        continue;
      }

      this.answer += this.pending;
      this.pending = '';
    }

    return this.snapshot();
  }

  private consumeDetectMode(): boolean {
    if (hasPartialBoundaryPrefix(this.pending, GEMMA_THOUGHT_CHANNEL_PREFIXES)) {
      return false;
    }

    const prefix = findBoundaryAtStart(this.pending, GEMMA_THOUGHT_CHANNEL_PREFIXES);
    if (prefix) {
      this.pending = this.pending.slice(prefix.length);
      this.mode = 'reasoning';
      return true;
    }

    const embeddedPrefix = findBoundaryInText(this.pending, GEMMA_THOUGHT_CHANNEL_PREFIXES);
    if (embeddedPrefix && embeddedPrefix.index > 0) {
      this.answer += this.pending.slice(0, embeddedPrefix.index);
      this.pending = this.pending.slice(embeddedPrefix.index);
      return true;
    }

    this.mode = 'answer';
    return true;
  }

  private consumeReasoningMode(): boolean {
    const suffixMatch = findBoundaryInText(this.pending, GEMMA_THOUGHT_CHANNEL_SUFFIXES);
    if (suffixMatch) {
      this.reasoning += this.pending.slice(0, suffixMatch.index);
      this.pending = this.pending.slice(suffixMatch.index + suffixMatch.boundary.length);
      this.mode = 'answer';
      return true;
    }

    const overlap = getBoundaryOverlap(this.pending, GEMMA_THOUGHT_CHANNEL_SUFFIXES);
    const stableText = this.pending.slice(0, this.pending.length - overlap);
    if (stableText) {
      this.reasoning += stableText;
      this.pending = this.pending.slice(stableText.length);
    }
    return false;
  }

  finalize(fullRawText: string): { reasoningText?: string; text: string } {
    const parsed = splitAnswerFromReasoningBlock(fullRawText);
    this.reasoning = parsed.reasoningText ?? '';
    this.answer = parsed.text;
    this.pending = '';
    this.mode = 'answer';
    return this.snapshot();
  }

  snapshot(): { reasoningText?: string; text: string } {
    return {
      ...(this.reasoning ? { reasoningText: normalizeWhitespace(this.reasoning) } : {}),
      text: stripGemmaControlTokens(this.answer),
    };
  }
}

function parseGenericToolCall(text: string): LocalLlmToolCall[] {
  const structuredToolCalls = parseGemmaStructuredToolCalls(text);
  if (structuredToolCalls.length > 0) {
    return structuredToolCalls;
  }

  const trimmed = text.trim();
  const candidates = [trimmed];
  const wrappedMatch = trimmed.match(/<tool_call>([\s\S]+?)<\/tool_call>/);
  if (wrappedMatch?.[1]) {
    candidates.unshift(wrappedMatch[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
        return [
          {
            function: {
              arguments: JSON.stringify(parsed.arguments ?? {}),
              name: parsed.name,
            },
            id: crypto.randomUUID(),
            type: 'function',
          },
        ];
      }
    } catch {
      // ignored
    }
  }

  return [];
}

function countTokens(tokenizer: TokenizerLike, text: string): number {
  const encoded = tokenizer.encode(text);
  return encoded.length;
}

interface GemmaStreamingState {
  finalize: (rawText: string) => { reasoningText?: string; text: string };
  readonly rawParts: string[];
  readonly streamer: GemmaTextStreamer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function createGemmaStreamingState(
  transformers: TransformersModule,
  tokenizer: unknown,
  thinkingEnabled: boolean,
  options: LocalLlmGenerationOptions
): GemmaStreamingState {
  const rawParts: string[] = [];
  const streamAccumulator = new Gemma4StreamAccumulator(thinkingEnabled);
  let lastReasoningSnapshot = '';
  let lastTextSnapshot = '';

  const emitSnapshot = (snapshot: { reasoningText?: string; text: string }): void => {
    if (snapshot.reasoningText && snapshot.reasoningText !== lastReasoningSnapshot) {
      lastReasoningSnapshot = snapshot.reasoningText;
      options.stream?.onStageChange?.('reasoning');
      options.stream?.onReasoningSnapshot?.(snapshot.reasoningText);
    }
    if (snapshot.text && snapshot.text !== lastTextSnapshot) {
      lastTextSnapshot = snapshot.text;
      options.stream?.onStageChange?.('responding');
      options.stream?.onTextSnapshot?.(snapshot.text);
    }
  };

  return {
    finalize: (rawText) => {
      const snapshot = streamAccumulator.finalize(rawText);
      emitSnapshot(snapshot);
      return snapshot;
    },
    rawParts,
    streamer: transformers.createTextStreamer(tokenizer, {
      callbackFunction: (text) => {
        throwIfAborted(options.signal);
        rawParts.push(text);
        emitSnapshot(streamAccumulator.append(text));
      },
      skipPrompt: true,
      skipSpecialTokens: false,
    }),
  };
}

/**
 * The practical WebGPU prompt ceiling varies per device — carry the
 * measurement on the visible generation failure so the limit can be
 * calibrated from the chat error itself. Cancellations are not faults.
 */
function appendPromptSizeToFault(error: unknown, promptTokenCount: number): void {
  if (error instanceof Error && error.name !== 'AbortError' && promptTokenCount > 0) {
    error.message = `${error.message} (prompt: ${promptTokenCount} tokens)`;
  }
}

export class Gemma4Engine {
  private model: GemmaModel | null = null;
  private processor: LoadedGemmaProcessor | null = null;
  private transformers: TransformersModule | null = null;

  constructor(private readonly spec: LocalLlmModelSpec) {}

  async initialize(device: 'webgpu', onProgress?: (progress: ProgressInfo) => void): Promise<void> {
    if (this.model && this.processor) {
      return;
    }

    let stage = 'resolve-transformers-module';
    try {
      logger.info('Gemma initialize started', {
        device,
        modelId: this.spec.modelId,
        quantization: this.spec.quantization,
        revision: this.spec.remoteRevision,
      });
      const transformers = await getTransformersModule();
      this.transformers = transformers;
      stage = 'load-processor';
      const processorOptions: LoaderOptions = {
        revision: this.spec.remoteRevision,
      };
      if (onProgress) {
        processorOptions.progressCallback = onProgress;
      }
      const processor = await transformers.loadProcessor(this.spec.modelId, processorOptions);
      logger.info('Gemma processor loaded', {
        modelId: this.spec.modelId,
        processor: describeCallable(processor),
      });
      stage = 'load-model';
      const modelOptions: ModelLoaderOptions = {
        device,
        dtype: this.spec.quantization,
        revision: this.spec.remoteRevision,
      };
      if (onProgress) {
        modelOptions.progressCallback = onProgress;
      }
      const model = await transformers.loadModel(this.spec.modelId, modelOptions);
      logger.info('Gemma model loaded', {
        model: describeCallable(model),
        modelId: this.spec.modelId,
      });

      this.processor = processor;
      this.model = model;
      logger.info('Gemma initialize completed', {
        device,
        modelId: this.spec.modelId,
      });
    } catch (error) {
      logger.error('Gemma initialize failed', {
        device,
        error: error instanceof Error ? error.message : String(error),
        modelId: this.spec.modelId,
        stage,
        ...(error instanceof Error && typeof error.stack === 'string'
          ? { stack: error.stack }
          : {}),
      });
      throw error;
    }
  }

  isReady(): boolean {
    return Boolean(this.processor && this.model);
  }

  async dispose(): Promise<void> {
    if (this.model?.dispose) {
      await this.model.dispose();
    }
    this.model = null;
    this.processor = null;
    this.transformers = null;
  }

  async generate(
    messages: readonly LocalLlmMessage[],
    options: LocalLlmGenerationOptions = {}
  ): Promise<Gemma4GenerateResult> {
    if (!(this.processor && this.model && this.transformers)) {
      throw new Error('Gemma engine is not initialized');
    }

    let stage = 'prepare-messages';
    // Captured after templating so the FAILURE log carries the prompt size —
    // WebGPU kernel errors (e.g. unaligned access aborts) are sequence-length
    // dependent, and the size is the first diagnostic question.
    let promptLength = 0;
    let promptTokenCount = 0;
    try {
      logger.info('Gemma generation started', {
        maxNewTokens: options.maxNewTokens ?? 512,
        messageCount: messages.length,
        modelId: this.spec.modelId,
        thinkingEnabled: options.thinking?.enabled ?? true,
        toolCount: options.tools?.length ?? 0,
      });
      const promptMessages = injectGemmaSystemMessages(messages);
      throwIfAborted(options.signal);
      stage = 'apply-chat-template';
      const promptText = this.processor.applyChatTemplate(promptMessages, {
        addGenerationPrompt: true,
        enableThinking: options.thinking?.enabled ?? true,
        ...(options.tools ? { tools: options.tools } : {}),
      });
      promptLength = promptText.length;

      const streamingState = createGemmaStreamingState(
        this.transformers,
        this.processor.tokenizer.raw,
        options.thinking?.enabled ?? true,
        options
      );

      stage = 'processor-run';
      throwIfAborted(options.signal);
      const inputs = await this.processor.run(promptText, null, null, { addSpecialTokens: false });
      promptTokenCount = inputs.inputIds.dims.at(-1) ?? 0;
      stage = 'model-generate';
      options.stream?.onStageChange?.('generating');
      throwIfAborted(options.signal);
      const outputs = await this.model.generate({
        ...inputs,
        ...buildGenerateOptions(options),
        streamer: streamingState.streamer,
      });

      stage = 'decode-output';
      throwIfAborted(options.signal);
      const inputLength = inputs.inputIds.dims.at(-1) ?? 0;
      const decoded = this.processor.batchDecode(outputs.slice(null, [inputLength, null]), {
        skipSpecialTokens: false,
      });
      const rawText = decoded[0] ?? streamingState.rawParts.join('');
      const parsedOutput = streamingState.finalize(rawText);
      const text = parsedOutput.text;
      const toolCalls = parseGenericToolCall(text);
      const visibleText = stripGemmaToolCallBlocks(text);
      stage = 'count-tokens';
      const promptTokens = countTokens(this.processor.tokenizer, promptText);
      const completionTokens = countTokens(this.processor.tokenizer, visibleText);

      logger.info('Gemma generation complete', {
        completionTokens,
        modelId: this.spec.modelId,
        promptLength: promptText.length,
        promptTokens,
        rawTextLength: rawText.length,
        toolCalls: toolCalls.length,
        visibleTextLength: visibleText.length,
      });

      return {
        promptText,
        rawText,
        ...(parsedOutput.reasoningText ? { reasoningText: parsedOutput.reasoningText } : {}),
        text: visibleText,
        toolCalls,
        usage: {
          completionTokens,
          promptTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } catch (error) {
      logger.error('Gemma generation failed', {
        error: error instanceof Error ? error.message : String(error),
        messageCount: messages.length,
        modelId: this.spec.modelId,
        promptLength,
        promptTokenCount,
        stage,
        thinkingEnabled: options.thinking?.enabled ?? true,
        toolCount: options.tools?.length ?? 0,
        ...(error instanceof Error && typeof error.stack === 'string'
          ? { stack: error.stack }
          : {}),
      });
      appendPromptSizeToFault(error, promptTokenCount);
      throw error;
    }
  }
}
