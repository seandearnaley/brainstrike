import { type ParserPlugin, parse } from '@babel/parser';
import {
  type ChunkingStrategy,
  countTokensHeuristic,
  isChunkingStrategy,
  RecursiveTextSplitter,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
  splitTextByStrategy,
} from '@brainstrike/text-splitter';
import {
  adjustChunkingForFileType as adjustChunkingForFileTypeShared,
  assertTokenBudgetIterationsWithinLimit,
  detectCodeLanguage,
  findBalancedSplitPoint,
  getCodeSeparators,
  getTopLevelFunctionRanges,
  resolveMaxTokensCap,
  shouldSkipChunking as shouldSkipChunkingShared,
  splitByBlankLines,
  splitCodeByFunctionRanges,
  splitMarkdownIntoBlocks,
} from '@brainstrike/text-splitter/chunking-core';

export type {
  ChunkingPresetDefinition,
  ChunkingPresetId,
  ChunkingPresetSelection,
  ChunkingStrategy,
  ResolvedChunkingStrategy,
} from '@brainstrike/text-splitter';

import { createLogger } from '@brainstrike/utils';
import { countTokensAccurate } from '@brainstrike/utils/token-counting-runtime';
import { CHUNKING_CONFIG } from '../config/chunking-config.js';
import type { FileChunkInsert } from '../models/file-chunk';

const logger = createLogger('ChunkingService');

async function countTokensAccurateStrict(text: string): Promise<number> {
  try {
    return await countTokensAccurate(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Accurate token counting is required for strict chunk sizing, but tiktoken is unavailable: ${message}`
    );
  }
}

export interface ChunkingOptions {
  // When true, allows chunking beyond maxChunkableSize using the streaming API
  allowLargeFiles?: boolean;
  fileName?: string;
  filePath?: string;
  // When true, honor the provided strategy without applying file-type heuristics
  forceStrategy?: boolean;
  // Skip file-type recommendations and only enforce global safety caps when true
  ignoreFileTypeRecommendations?: boolean;
  maxTokens?: number;
  // Optional override for the global max token budget per chunk
  maxTokensCap?: number;
  // Notify caller which strategy was actually used after file/extension heuristics
  onStrategyResolved?: (strategy: ResolvedChunkingStrategy) => void;
  overlap?: number;
  separators?: string[];
  strategy: ChunkingStrategy;
  // Optional token counter for token-true sizing and reporting
  tokenCounter?: (text: string) => Promise<number>;
  // If true, derive character limits from measured chars/token for this content
  tokenTrueSizing?: boolean;
}

export interface ChunkingResult {
  avgTokensPerChunk: number;
  chunks: FileChunkInsert[];
  skipped?: boolean;
  skipReason?: string;
  strategyUsed: ResolvedChunkingStrategy;
  totalTokens: number;
}

type CodeLanguage = keyof typeof CHUNKING_CONFIG.codeLanguageDefaults;

type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

export class ChunkingService {
  async chunkContent(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'auto' }
  ): Promise<ChunkingResult> {
    const initialStrategy = resolveChunkingStrategyForFile(
      options.filePath ?? options.fileName ?? '',
      options.strategy
    );
    let strategyUsed: ResolvedChunkingStrategy = initialStrategy;
    logger.debug(`Starting chunkContent for fileRecordId: ${fileRecordId}`);
    logger.debug(`Content length: ${content?.length || 0}`);
    logger.debug('Options', options);

    if (!(content && fileRecordId)) {
      logger.error('Missing required parameters', {
        hasContent: !!content,
        fileRecordId,
      });
      throw new Error('Content and fileRecordId are required for chunking');
    }

    // Check if we should skip this file
    const skipResult = this.shouldSkipChunking(content, options);
    if (skipResult.skip) {
      return {
        chunks: [],
        totalTokens: 0,
        avgTokensPerChunk: 0,
        strategyUsed,
        skipped: true,
        skipReason: skipResult.reason || 'Unknown reason',
      };
    }

    const { strategy } = options;
    if (!isChunkingStrategy(strategy)) {
      logger.error(`Unsupported chunking strategy: ${String(strategy)}`);
      throw new Error(`Unsupported chunking strategy: ${String(strategy)}`);
    }

    // Note: adjustChunkingForFileType is called inside chunkContentStream, not here,
    // to avoid double-adjustment when chunkContent delegates to the streaming path.

    // Collect by iterating the streaming API to minimize additional memory
    const chunks: FileChunkInsert[] = [];
    let totalTokens = 0;
    let idx = 0;
    for await (const chunk of this.chunkContentStream(content, fileRecordId, {
      ...options,
      onStrategyResolved: (resolved) => {
        strategyUsed = resolved;
      },
    })) {
      chunks.push({ ...chunk, chunkIndex: idx++ });
      totalTokens += chunk.tokenCount;
    }
    const avgTokensPerChunk = chunks.length ? totalTokens / chunks.length : 0;
    return { chunks, totalTokens, avgTokensPerChunk, strategyUsed };
  }

  private shouldSkipChunking(
    content: string,
    options: ChunkingOptions
  ): { skip: boolean; reason?: string } {
    return shouldSkipChunkingShared(content, options, CHUNKING_CONFIG.maxChunkableSize);
  }

  private adjustChunkingForFileType(
    content: string,
    options: ChunkingOptions
  ): { maxTokens: number; overlap: number } {
    return adjustChunkingForFileTypeShared(
      content,
      options,
      CHUNKING_CONFIG,
      (fileName: string) => detectCodeLanguage(fileName) as CodeLanguage | null
    );
  }

  // (legacy) processChunks removed; streaming path is preferred.

  private estimateTokenCount(text: string): number {
    return countTokensHeuristic(text);
  }

  private async generateContentHash(content: string): Promise<string> {
    // Use the proper crypto utility for content hashing
    /* Stryker disable next-line StringLiteral */
    const { generateContentHash } = await import('@brainstrike/utils');
    return generateContentHash(content);
  }

  async dispose(): Promise<void> {
    // Clean up any resources (no longer needed as we create splitters on-demand)
  }

  /**
   * Re-split an oversized chunk into smaller pieces using the shared recursive splitter.
   * This is a fallback for when character-based splitters produce chunks that exceed token limits.
   * The shared implementation keeps browser and desktop workers aligned without LangChain.
   */
  private async reSplitOversizedChunk(
    content: string,
    maxTokens: number,
    overlap: number
  ): Promise<string[]> {
    // Convert token limits to character limits using averageCharsPerToken ratio
    const charsPerToken = CHUNKING_CONFIG.averageCharsPerToken;
    const maxChars = Math.floor(maxTokens * charsPerToken);
    const overlapChars = Math.min(Math.floor(overlap * charsPerToken), Math.floor(maxChars / 10));

    const recursiveChunker = new RecursiveTextSplitter({
      chunkSize: maxChars,
      chunkOverlap: overlapChars,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });
    return recursiveChunker.splitText(content);
  }

  /**
   * Generate sub-chunks from an oversized piece of text.
   * Extracted to reduce cognitive complexity of the main emit function.
   */
  private async generateSubChunks(
    subPieces: string[],
    fileRecordId: string,
    startSeq: number,
    maxTokens: number,
    nowIso: () => string,
    tokenCounter?: (text: string) => Promise<number>
  ): Promise<{ chunks: FileChunkInsert[]; count: number }> {
    const chunks: FileChunkInsert[] = [];
    let seq = startSeq;

    for (const subTxt of subPieces) {
      const subC = subTxt?.trim();
      if (!subC) {
        continue;
      }
      const subTokenCount = tokenCounter ? await tokenCounter(subC) : this.estimateTokenCount(subC);
      const subContentHash = await this.generateContentHash(subC);
      const now = nowIso();
      const id = `${fileRecordId}_chunk_${seq}`;
      chunks.push({
        id,
        fileRecordId,
        chunkIndex: seq,
        content: subC,
        contentHash: subContentHash,
        tokenCount: subTokenCount,
        chunkType: 'text' as const,
        chunkSize: maxTokens,
        createdAt: now,
        updatedAt: now,
      });
      seq++;
    }

    return { chunks, count: chunks.length };
  }

  private async splitChunkToTokenBudget(
    content: string,
    maxTokens: number,
    overlap: number,
    tokenCounter: (text: string) => Promise<number>
  ): Promise<Array<{ content: string; tokenCount: number }>> {
    const pendingPieces: string[] = [content];
    const resolvedPieces: Array<{ content: string; tokenCount: number }> = [];
    let iterations = 0;
    const maxIterations = 10_000;

    while (pendingPieces.length > 0) {
      iterations += 1;
      assertTokenBudgetIterationsWithinLimit(iterations, maxIterations);
      const nextPiece = pendingPieces.shift();
      if (!nextPiece) {
        continue;
      }

      const normalizedPiece = nextPiece.trim();
      if (!normalizedPiece) {
        continue;
      }

      const tokenCount = await tokenCounter(normalizedPiece);
      if (tokenCount <= maxTokens) {
        resolvedPieces.push({ content: normalizedPiece, tokenCount });
        continue;
      }

      if (normalizedPiece.length <= 1) {
        throw new Error(
          `Unable to split chunk to token budget without progress (tokens=${String(tokenCount)}, limit=${String(maxTokens)})`
        );
      }

      const splitTarget = Math.max(1, Math.min(maxTokens, tokenCount - 1));
      const splitPieces = await this.reSplitOversizedChunk(normalizedPiece, splitTarget, overlap);
      const normalizedSplitPieces = splitPieces
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0);

      if (normalizedSplitPieces.length <= 1) {
        const splitIndex = findBalancedSplitPoint(normalizedPiece);
        const left = normalizedPiece.slice(0, splitIndex).trim();
        const right = normalizedPiece.slice(splitIndex).trim();
        if (!(left && right)) {
          throw new Error(
            `Unable to split chunk to token budget without progress (tokens=${String(tokenCount)}, limit=${String(maxTokens)})`
          );
        }
        pendingPieces.unshift(right, left);
        continue;
      }

      for (let index = normalizedSplitPieces.length - 1; index >= 0; index -= 1) {
        const piece = normalizedSplitPieces[index];
        if (piece) {
          pendingPieces.unshift(piece);
        }
      }
    }

    return resolvedPieces;
  }

  private async generateChunksFromMeasuredPieces(
    pieces: Array<{ content: string; tokenCount: number }>,
    fileRecordId: string,
    startSeq: number,
    maxTokens: number,
    nowIso: () => string,
    chunkType: FileChunkInsert['chunkType']
  ): Promise<{ chunks: FileChunkInsert[]; count: number }> {
    const chunks: FileChunkInsert[] = [];
    let seq = startSeq;

    for (const piece of pieces) {
      const content = piece.content.trim();
      if (!content) {
        continue;
      }

      const contentHash = await this.generateContentHash(content);
      const now = nowIso();
      const id = `${fileRecordId}_chunk_${seq}`;
      chunks.push({
        id,
        fileRecordId,
        chunkIndex: seq,
        content,
        contentHash,
        tokenCount: piece.tokenCount,
        chunkType,
        chunkSize: maxTokens,
        createdAt: now,
        updatedAt: now,
      });
      seq += 1;
    }

    return { chunks, count: chunks.length };
  }

  private async handleOversizedChunk({
    content,
    chunkType,
    fileRecordId,
    tokenCount,
    tokenLimit,
    tokenTrueSizing,
    maxSafeTokens,
    maxTokens,
    effectiveOverlap,
    startSeq,
    nowIso,
    tokenCounter,
  }: {
    content: string;
    chunkType: FileChunkInsert['chunkType'];
    fileRecordId: string;
    tokenCount: number;
    tokenLimit: number;
    tokenTrueSizing: boolean;
    maxSafeTokens: number;
    maxTokens: number;
    effectiveOverlap: number;
    startSeq: number;
    nowIso: () => string;
    tokenCounter?: (text: string) => Promise<number>;
  }): Promise<{ chunks: FileChunkInsert[]; count: number }> {
    const logDetails = {
      fileRecordId,
      originalTokens: tokenCount,
      tokenLimit,
      tokenTrueSizing,
      maxSafeTokens,
      charCount: content.length,
    };
    if (tokenTrueSizing) {
      logger.debug('Chunk exceeds strict token budget, re-splitting', logDetails);
      const strictCounter = tokenCounter ?? countTokensAccurateStrict;
      const budgetedPieces = await this.splitChunkToTokenBudget(
        content,
        maxTokens,
        effectiveOverlap,
        strictCounter
      );
      return this.generateChunksFromMeasuredPieces(
        budgetedPieces,
        fileRecordId,
        startSeq,
        maxTokens,
        nowIso,
        chunkType
      );
    }

    logger.warn('Chunk exceeds safe token limit, re-splitting', logDetails);
    const subPieces = await this.reSplitOversizedChunk(
      content,
      Math.min(maxTokens, maxSafeTokens),
      effectiveOverlap
    );
    return this.generateSubChunks(
      subPieces,
      fileRecordId,
      startSeq,
      maxTokens,
      nowIso,
      tokenCounter
    );
  }

  private async processStreamPiece({
    rawText,
    chunkType,
    fileRecordId,
    seq,
    maxTokens,
    tokenTrueSizing,
    maxSafeTokens,
    effectiveOverlap,
    nowIso,
    tokenCounter,
  }: {
    rawText: string;
    chunkType: FileChunkInsert['chunkType'];
    fileRecordId: string;
    seq: number;
    maxTokens: number;
    tokenTrueSizing: boolean;
    maxSafeTokens: number;
    effectiveOverlap: number;
    nowIso: () => string;
    tokenCounter?: (text: string) => Promise<number>;
  }): Promise<{ chunks: FileChunkInsert[]; nextSeq: number }> {
    const content = rawText.trim();
    if (!content) {
      return { chunks: [], nextSeq: seq };
    }

    const measuredTokenCount = tokenCounter
      ? await tokenCounter(content)
      : this.estimateTokenCount(content);
    const tokenLimit = tokenTrueSizing ? maxTokens : maxSafeTokens;

    if (measuredTokenCount > tokenLimit) {
      const { chunks: oversizedChunks, count } = await this.handleOversizedChunk({
        content,
        chunkType,
        fileRecordId,
        tokenCount: measuredTokenCount,
        tokenLimit,
        tokenTrueSizing,
        maxSafeTokens,
        maxTokens,
        effectiveOverlap,
        startSeq: seq,
        nowIso,
        ...(tokenCounter ? { tokenCounter } : {}),
      });
      return { chunks: oversizedChunks, nextSeq: seq + count };
    }

    const contentHash = await this.generateContentHash(content);
    const now = nowIso();
    const id = `${fileRecordId}_chunk_${seq}`;
    return {
      chunks: [
        {
          id,
          fileRecordId,
          chunkIndex: seq,
          content,
          contentHash,
          tokenCount: measuredTokenCount,
          chunkType,
          chunkSize: maxTokens,
          createdAt: now,
          updatedAt: now,
        } satisfies FileChunkInsert,
      ],
      nextSeq: seq + 1,
    };
  }

  /**
   * Streaming chunk production to reduce peak memory.
   * Yields FileChunkInsert items without materializing a large array.
   */
  async *chunkContentStream(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'auto' }
  ): AsyncGenerator<FileChunkInsert> {
    if (!(content && fileRecordId)) {
      throw new Error('Content and fileRecordId are required for chunking');
    }

    // Check skip patterns BEFORE processing (fix: streaming path was bypassing this)
    const skipResult = this.shouldSkipChunking(content, options);
    if (skipResult.skip) {
      logger.info('Skipping chunking for file (streaming path)', {
        fileRecordId,
        fileName: options.fileName,
        reason: skipResult.reason,
      });
      return; // Yield nothing - file should be skipped
    }

    const adjusted = this.adjustChunkingForFileType(content, options);
    const maxTokensCap = resolveMaxTokensCap(
      options.maxTokensCap,
      CHUNKING_CONFIG.maxTokensHardLimit,
      CHUNKING_CONFIG.maxTokensSafetyCap
    );
    const effectiveMaxTokens = Math.min(adjusted.maxTokens, maxTokensCap);
    const effectiveOverlap = Math.min(adjusted.overlap, CHUNKING_CONFIG.overlapSafetyCap);
    const nowIso = () => new Date().toISOString();

    // Maximum safe token limit for embedding models (OpenAI's limit is 8192, use conservative value)
    const maxSafeTokens = Math.min(effectiveMaxTokens * 4, CHUNKING_CONFIG.maxTokensSafetyCap);

    let seq = 0;
    const emit = async function* (
      this: ChunkingService,
      pieces: string[],
      chunkType: FileChunkInsert['chunkType'],
      maxTokens: number
    ): AsyncGenerator<FileChunkInsert> {
      for (const txt of pieces) {
        const { chunks: emittedChunks, nextSeq } = await this.processStreamPiece({
          rawText: txt,
          chunkType,
          fileRecordId,
          seq,
          maxTokens,
          tokenTrueSizing: options.tokenTrueSizing === true,
          maxSafeTokens,
          effectiveOverlap,
          nowIso,
          ...(options.tokenCounter ? { tokenCounter: options.tokenCounter } : {}),
        });
        for (const chunk of emittedChunks) {
          yield chunk;
        }
        seq = nextSeq;
      }
    }.bind(this);

    // Strategy selection with streaming-friendly implementations
    // Optionally measure chars/token on a sample to derive char limits from token limits
    let charsPerToken: number = Number(CHUNKING_CONFIG.averageCharsPerToken);
    if (options.tokenTrueSizing) {
      charsPerToken = await computeCharsPerToken(content, options);
    }

    const maxChars = Math.floor(effectiveMaxTokens * charsPerToken);
    const overlapChars = Math.floor(effectiveOverlap * charsPerToken);

    const name = (options.fileName || options.filePath || '').toLowerCase();
    const codeLanguage = detectCodeLanguage(name);
    const isCode = Boolean(codeLanguage);
    const resolvedAutoStrategy = resolveChunkingStrategyForFile(name, 'auto');

    interface ChunkGroup {
      pieces: string[];
      type: FileChunkInsert['chunkType'];
    }

    const splitMarkdownBlocks = async (): Promise<ChunkGroup[]> => {
      const blocks = splitMarkdownIntoBlocks(content);
      const groups: ChunkGroup[] = [];
      for (const block of blocks) {
        if (block.meta.isFence) {
          const parts =
            block.text.length > maxChars * 2 ? splitByBlankLines(block.text) : [block.text];
          groups.push({ pieces: parts, type: 'recursive' });
        } else {
          groups.push({
            pieces: splitTextByStrategy(block.text, {
              strategy: 'markdown',
              chunkSize: maxChars,
              chunkOverlap: overlapChars,
            }),
            type: 'sentence',
          });
        }
      }
      return groups;
    };

    const chunkCode = async (): Promise<ChunkGroup[]> => {
      const supportsAst = codeLanguage === 'typescript' || codeLanguage === 'javascript';

      const chunkWithCodeSeparators = async (): Promise<ChunkGroup[]> => {
        const codeSeparators = getCodeSeparators(options.separators);
        const recursiveChunker = new RecursiveTextSplitter({
          chunkSize: maxChars,
          chunkOverlap: overlapChars,
          separators: codeSeparators,
        });
        return [{ pieces: await recursiveChunker.splitText(content), type: 'recursive' }];
      };

      if (supportsAst) {
        const pieces = await splitCodeByFunctions(content, {
          maxChars,
          overlapChars,
          language: codeLanguage,
          separators: getCodeSeparators(options.separators),
        });

        if (pieces && pieces.length > 0) {
          return [{ pieces, type: 'recursive' }];
        }

        logger.debug('AST-aware chunking unavailable, falling back to separator-based chunks', {
          fileName: options.fileName,
          filePath: options.filePath,
        });

        return chunkWithCodeSeparators();
      }
      if (codeLanguage) {
        return chunkWithCodeSeparators();
      }

      return [
        {
          pieces: splitTextByStrategy(content, {
            strategy: 'token',
            chunkSize: maxChars,
            chunkOverlap: overlapChars,
          }),
          type: 'text',
        },
      ];
    };

    let groups: ChunkGroup[] = [];
    const effectiveStrategy: ResolvedChunkingStrategy = resolveEffectiveChunkingStrategy({
      requested: options.strategy,
      resolvedAutoStrategy,
      isCode,
    });
    let strategyNotified = false;
    const notifyStrategy = (strategy: ResolvedChunkingStrategy) => {
      if (strategyNotified) {
        return;
      }
      strategyNotified = true;
      options.onStrategyResolved?.(strategy);
    };

    if (effectiveStrategy === 'recursive' && isCode) {
      groups = await chunkCode();
    } else if (effectiveStrategy === 'markdown') {
      groups = await splitMarkdownBlocks();
    } else {
      const chunkType: FileChunkInsert['chunkType'] =
        effectiveStrategy === 'character' || effectiveStrategy === 'token'
          ? 'text'
          : effectiveStrategy === 'recursive' || effectiveStrategy === 'json'
            ? 'recursive'
            : 'sentence';
      groups = [
        {
          pieces: splitTextByStrategy(content, {
            strategy: effectiveStrategy,
            chunkSize: maxChars,
            chunkOverlap: overlapChars,
            ...(effectiveStrategy === 'recursive' && options.separators
              ? { separators: getCodeSeparators(options.separators) }
              : {}),
          }),
          type: chunkType,
        },
      ];
    }
    notifyStrategy(effectiveStrategy);
    for (const g of groups) {
      yield* emit(g.pieces, g.type, effectiveMaxTokens);
    }
  }
}

async function splitCodeByFunctions(
  content: string,
  {
    maxChars,
    overlapChars,
    language,
    separators,
  }: { maxChars: number; overlapChars: number; language: CodeLanguage | null; separators: string[] }
): Promise<string[] | null> {
  const plugins: ParserPlugin[] = [
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'importAttributes',
    'topLevelAwait',
    'jsx',
  ];

  if (language === 'typescript') {
    plugins.push('typescript');
  }

  let ast: AstNode | null = null;
  try {
    ast = parse(content, {
      sourceType: 'module',
      plugins,
      errorRecovery: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (error) {
    logger.debug('Failed to parse code for AST-aware chunking', {
      error,
    });
    return null;
  }

  const ranges = getTopLevelFunctionRanges(ast);

  if (!ranges.length) {
    return null;
  }

  return splitCodeByFunctionRanges(content, {
    maxChars,
    overlapChars,
    ranges,
    separators,
  });
}

// Utilities for streaming splitter
async function computeCharsPerToken(content: string, options: ChunkingOptions): Promise<number> {
  const counter = options.tokenCounter ?? countTokensAccurateStrict;
  const sample = content.slice(0, Math.min(10_000, content.length));
  try {
    const tokens = await counter(sample);
    if (Number.isFinite(tokens) && tokens > 0) {
      const measured = sample.length / (tokens as number);
      return Math.max(1, Math.min(8, measured));
    }
  } catch (error) {
    logger.debug('Token counter failed, using average character-to-token ratio', {
      error,
      sampleLength: sample.length,
    });
  }
  return Number(CHUNKING_CONFIG.averageCharsPerToken);
}
