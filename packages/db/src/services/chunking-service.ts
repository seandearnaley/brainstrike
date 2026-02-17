import { type ParserPlugin, parse } from '@babel/parser';
import { countTokensAccurate, createLogger } from '@brainstrike/utils';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { CHUNKING_CONFIG } from '../config/chunking-config.js';
import type { FileChunkInsert } from '../models/file-chunk';

const logger = createLogger('ChunkingService');

export type ChunkingStrategy = 'sentence' | 'token' | 'recursive';

export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxTokens?: number;
  overlap?: number;
  separators?: string[];
  fileName?: string;
  filePath?: string;
  // When true, allows chunking beyond maxChunkableSize using the streaming API
  allowLargeFiles?: boolean;
  // When true, honor the provided strategy without applying file-type heuristics
  forceStrategy?: boolean;
  // Optional token counter for token-true sizing and reporting
  tokenCounter?: (text: string) => Promise<number>;
  // If true, derive character limits from measured chars/token for this content
  tokenTrueSizing?: boolean;
  // Optional override for the global max token budget per chunk
  maxTokensCap?: number;
  // Notify caller which strategy was actually used after file/extension heuristics
  onStrategyResolved?: (strategy: ChunkingStrategy) => void;
  // Skip file-type recommendations and only enforce global safety caps when true
  ignoreFileTypeRecommendations?: boolean;
}

export interface ChunkingResult {
  chunks: FileChunkInsert[];
  totalTokens: number;
  avgTokensPerChunk: number;
  strategyUsed: ChunkingStrategy;
  skipped?: boolean;
  skipReason?: string;
}

// File patterns that should be skipped or handled differently (path or name)
const SKIP_CHUNKING_PATTERNS = [
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /composer\.lock$/i,
  /Gemfile\.lock$/i,
  /Pipfile\.lock$/i,
  /poetry\.lock$/i,
  /go\.sum$/i,
  /Cargo\.lock$/i,
  /npm-shrinkwrap\.json$/i,
  // Large vendor/build artifacts and maps
  /\.min\.[jt]s$/i,
  /\.map$/i,
  /\.wasm$/i,
  /\.bin$/i,
  // Common large directories
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
];

type CodeLanguage = keyof typeof CHUNKING_CONFIG.codeLanguageDefaults;

const CODE_LANGUAGE_PATTERNS: Array<{ pattern: RegExp; language: CodeLanguage }> = [
  { pattern: /\.vue$/i, language: 'javascript' },
  { pattern: /\.svelte$/i, language: 'javascript' },
  { pattern: /\.(ts|tsx|mts|cts)$/i, language: 'typescript' },
  { pattern: /\.(js|jsx|mjs|cjs)$/i, language: 'javascript' },
  { pattern: /\.mm$/i, language: 'cpp' },
  { pattern: /\.m$/i, language: 'cpp' },
  { pattern: /\.py$/i, language: 'python' },
  { pattern: /\.rs$/i, language: 'rust' },
  { pattern: /\.go$/i, language: 'go' },
  { pattern: /\.(java|class)$/i, language: 'java' },
  { pattern: /\.cs$/i, language: 'csharp' },
  { pattern: /\.(c|cc|cpp|cxx|h|hh|hpp)$/i, language: 'cpp' },
  { pattern: /\.rb$/i, language: 'ruby' },
  { pattern: /\.php$/i, language: 'php' },
  { pattern: /\.swift$/i, language: 'swift' },
  { pattern: /\.(kt|kts)$/i, language: 'kotlin' },
];

type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

function detectCodeLanguage(fileName: string): CodeLanguage | null {
  const name = fileName.toLowerCase();
  for (const { pattern, language } of CODE_LANGUAGE_PATTERNS) {
    if (pattern.test(name)) {
      return language;
    }
  }
  return null;
}

// Large structured files that should use more aggressive chunking
const LARGE_STRUCTURED_PATTERNS = [
  /\.json$/i,
  /\.xml$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.sql$/i,
  /\.log$/i,
];

// Import the maximum file size from config
const { maxChunkableSize } = CHUNKING_CONFIG;

export class ChunkingService {
  async chunkContent(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'sentence' }
  ): Promise<ChunkingResult> {
    let strategyUsed: ChunkingStrategy = options.strategy;
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
    if (strategy !== 'sentence' && strategy !== 'token' && strategy !== 'recursive') {
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
    // Check file path/name against skip patterns
    const fileName = options.fileName || options.filePath || '';
    for (const pattern of SKIP_CHUNKING_PATTERNS) {
      if (pattern.test(fileName)) {
        return {
          skip: true,
          reason: `Lock file or dependency manifest: ${fileName}`,
        };
      }
    }

    // Skip binary-like content early (NUL bytes in the first few KB)
    const probeWindow = content.slice(0, 4096);
    if (probeWindow.includes('\u0000')) {
      return { skip: true, reason: 'Binary content detected (NUL bytes present)' };
    }

    // Check content size
    if (!options.allowLargeFiles && content.length > maxChunkableSize) {
      return {
        skip: true,
        reason: `File too large: ${Math.round(content.length / 1024)}KB (max: ${Math.round(
          maxChunkableSize / 1024
        )}KB)`,
      };
    }

    // Check for very repetitive content (common in generated files)
    const uniqueLines = new Set(content.split('\n')).size;
    const totalLines = content.split('\n').length;
    if (totalLines > 1000 && uniqueLines / totalLines < 0.1) {
      return {
        skip: true,
        reason: 'Highly repetitive content (likely generated file)',
      };
    }

    return { skip: false };
  }

  private adjustChunkingForFileType(
    content: string,
    options: ChunkingOptions
  ): { maxTokens: number; overlap: number } {
    const fileName = options.fileName || options.filePath || '';
    const ignoreRecommendations = options.ignoreFileTypeRecommendations === true;
    const maxTokensCap = resolveMaxTokensCap(options.maxTokensCap);

    const normalize = (value: number | undefined, fallback: number, minimum: number): number => {
      const candidate = Number.isFinite(value) ? (value as number) : fallback;
      return Math.max(minimum, Math.floor(candidate));
    };

    const requestedMaxTokens = options.maxTokens;
    const requestedOverlap = options.overlap;
    const hasExplicitMaxTokens = requestedMaxTokens !== undefined;
    const hasExplicitOverlap = requestedOverlap !== undefined;

    // Normalize inputs to sane integer values
    let maxTokens = hasExplicitMaxTokens
      ? normalize(requestedMaxTokens, CHUNKING_CONFIG.defaultMaxTokens, 1)
      : Number.POSITIVE_INFINITY;
    let overlap = hasExplicitOverlap
      ? normalize(requestedOverlap, CHUNKING_CONFIG.defaultOverlap, 0)
      : Number.POSITIVE_INFINITY;

    interface ChunkAdjustment {
      maxTokens: number;
      overlap: number;
    }
    const apply = (state: ChunkAdjustment, cap: Partial<ChunkAdjustment>) => {
      const next: ChunkAdjustment = { ...state };
      if (typeof cap.maxTokens === 'number') {
        next.maxTokens = Math.min(state.maxTokens, cap.maxTokens);
      }
      if (typeof cap.overlap === 'number') {
        next.overlap = Math.min(state.overlap, cap.overlap);
      }
      return next;
    };

    if (!ignoreRecommendations) {
      const adjustments: Array<(state: ChunkAdjustment) => ChunkAdjustment> = [];
      const codeLanguage = detectCodeLanguage(fileName);
      const isCode = Boolean(codeLanguage);
      if (isCode) {
        adjustments.push((state) => {
          const cap: Partial<ChunkAdjustment> = {};
          const languageDefaults = codeLanguage
            ? CHUNKING_CONFIG.codeLanguageDefaults[codeLanguage]
            : undefined;
          if (!hasExplicitMaxTokens) {
            cap.maxTokens = languageDefaults?.maxTokens ?? CHUNKING_CONFIG.codeMaxTokens;
          }
          if (!hasExplicitOverlap) {
            cap.overlap = languageDefaults?.overlap ?? CHUNKING_CONFIG.codeOverlap;
          }
          return apply(state, cap);
        });
      }

      const matchesStructured = LARGE_STRUCTURED_PATTERNS.some((pattern) => pattern.test(fileName));
      if (matchesStructured) {
        adjustments.push((state) => {
          const cap: Partial<ChunkAdjustment> = {};
          if (!hasExplicitMaxTokens) {
            cap.maxTokens = CHUNKING_CONFIG.largeStructuredMaxTokens;
          }
          if (!hasExplicitOverlap) {
            cap.overlap = CHUNKING_CONFIG.largeStructuredOverlap;
          }
          return apply(state, cap);
        });
      }

      const exceedsVeryLargeThreshold = content.length > CHUNKING_CONFIG.veryLargeContentThreshold;
      if (exceedsVeryLargeThreshold) {
        adjustments.push((state) => {
          const cap: Partial<ChunkAdjustment> = {};
          if (!hasExplicitMaxTokens) {
            cap.maxTokens = CHUNKING_CONFIG.veryLargeMaxTokens;
          }
          if (!hasExplicitOverlap) {
            cap.overlap = CHUNKING_CONFIG.veryLargeOverlap;
          }
          return apply(state, cap);
        });
      }

      let state: ChunkAdjustment = { maxTokens, overlap };
      for (const adjust of adjustments) {
        state = adjust(state);
      }
      maxTokens = state.maxTokens;
      overlap = state.overlap;
    }

    // Enforce hard safety limits for explicitly provided values and defaults alike
    const clamp = (value: number, fallback: number, limit: number) => {
      if (!Number.isFinite(value)) {
        return fallback;
      }
      return Math.max(1, Math.min(value, limit));
    };

    const resolveLimit = (hardLimit: number, safetyCap: number, explicit: boolean) =>
      explicit ? hardLimit : Math.min(hardLimit, safetyCap);

    const maxTokensLimit = resolveLimit(
      CHUNKING_CONFIG.maxTokensHardLimit,
      maxTokensCap,
      hasExplicitMaxTokens
    );
    const overlapLimit = resolveLimit(
      CHUNKING_CONFIG.overlapHardLimit,
      CHUNKING_CONFIG.overlapSafetyCap,
      hasExplicitOverlap
    );

    maxTokens = clamp(maxTokens, CHUNKING_CONFIG.defaultMaxTokens, maxTokensLimit);
    overlap = clamp(overlap, CHUNKING_CONFIG.defaultOverlap, overlapLimit);

    if (overlap >= maxTokens) {
      overlap = Math.max(0, maxTokens - 1);
    }

    return { maxTokens, overlap };
  }

  // (legacy) processChunks removed; streaming path is preferred.

  private estimateTokenCount(text: string): number {
    // Standard token estimation for embeddings
    // Use the standard estimate: 1 token ≈ 4 characters (GPT tokenization)
    const charCount = text.length;
    return Math.ceil(charCount / 4);
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
   * Re-split an oversized chunk into smaller pieces using RecursiveCharacterTextSplitter.
   * This is a fallback for when character-based splitters produce chunks that exceed token limits.
   * Note: We use character-based splitting (not TokenTextSplitter) because tiktoken requires
   * fetching external resources which is blocked by Electron's Content Security Policy.
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

    const recursiveChunker = new RecursiveCharacterTextSplitter({
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

  /**
   * Streaming chunk production to reduce peak memory.
   * Yields FileChunkInsert items without materializing a large array.
   */
  async *chunkContentStream(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'sentence' }
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
    const maxTokensCap = resolveMaxTokensCap(options.maxTokensCap);
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
        const c = txt?.trim();
        if (!c) {
          continue;
        }
        const tokenCount = options.tokenCounter
          ? await options.tokenCounter(c)
          : this.estimateTokenCount(c);

        // If chunk exceeds safe token limit, re-split it using RecursiveCharacterTextSplitter
        if (tokenCount > maxSafeTokens) {
          logger.warn('Chunk exceeds safe token limit, re-splitting', {
            fileRecordId,
            originalTokens: tokenCount,
            maxSafeTokens,
            charCount: c.length,
          });

          // Re-split using helper method to enforce token limits
          const subPieces = await this.reSplitOversizedChunk(
            c,
            Math.min(maxTokens, maxSafeTokens),
            effectiveOverlap
          );
          const { chunks: subChunks, count } = await this.generateSubChunks(
            subPieces,
            fileRecordId,
            seq,
            maxTokens,
            nowIso,
            options.tokenCounter
          );
          for (const chunk of subChunks) {
            yield chunk;
          }
          seq += count;
          continue; // Skip the original oversized chunk
        }

        const contentHash = await this.generateContentHash(c);
        const now = nowIso();
        const id = `${fileRecordId}_chunk_${seq}`;
        yield {
          id,
          fileRecordId,
          chunkIndex: seq,
          content: c,
          contentHash,
          tokenCount,
          chunkType,
          chunkSize: maxTokens,
          createdAt: now,
          updatedAt: now,
        } satisfies FileChunkInsert;
        seq++;
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
    const isMarkdown = /\.(md|mdx|markdown)$/.test(name);
    const isCode = Boolean(codeLanguage);
    // Detect structured data files that need special splitting (JSON, XML, YAML, etc.)
    const isStructuredData = /\.(json|xml|yaml|yml|csv|tsv)$/.test(name);

    interface ChunkGroup {
      pieces: string[];
      type: FileChunkInsert['chunkType'];
    }

    const chunkTokens = async (): Promise<ChunkGroup[]> => {
      // Note: We use RecursiveCharacterTextSplitter instead of TokenTextSplitter because
      // tiktoken requires fetching external resources which is blocked by Electron's CSP.
      const tokenChunker = new RecursiveCharacterTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separators: ['\n\n', '\n', '. ', ' ', ''],
      });
      return [{ pieces: await tokenChunker.splitText(content), type: 'text' }];
    };

    const chunkSentenceAwareText = async (text: string): Promise<string[]> => {
      const sentenceAwareChunker = new RecursiveCharacterTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separators: ['\n\n', '\n', '. ', ' ', ''],
      });
      return sentenceAwareChunker.splitText(text);
    };

    const splitMarkdownBlocks = async (): Promise<ChunkGroup[]> => {
      const blocks = splitMarkdownIntoBlocks(content);
      const groups: ChunkGroup[] = [];
      for (const block of blocks) {
        if (block.meta.isFence) {
          const parts =
            block.text.length > maxChars * 2 ? splitByBlankLines(block.text) : [block.text];
          groups.push({ pieces: parts, type: 'recursive' });
        } else {
          groups.push({ pieces: await chunkSentenceAwareText(block.text), type: 'sentence' });
        }
      }
      return groups;
    };

    const chunkMarkdown = async (): Promise<ChunkGroup[]> => splitMarkdownBlocks();

    const chunkCode = async (): Promise<ChunkGroup[]> => {
      const supportsAst = codeLanguage === 'typescript' || codeLanguage === 'javascript';

      const chunkWithCodeSeparators = async (): Promise<ChunkGroup[]> => {
        const codeSeparators = getCodeSeparators(options.separators);
        const recursiveChunker = new RecursiveCharacterTextSplitter({
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

      // Unsupported/unknown languages fall back to token-based chunking to avoid mid-function splits
      effectiveStrategy = 'token';
      return chunkTokens();
    };

    const chunkText = async (): Promise<ChunkGroup[]> => {
      return [{ pieces: await chunkSentenceAwareText(content), type: 'sentence' }];
    };

    // Use RecursiveCharacterTextSplitter for structured data (JSON, XML, etc.)
    // These files have no sentence boundaries, so we split on structural elements
    const chunkStructuredData = async (): Promise<ChunkGroup[]> => {
      const structuredSeparators = [
        '\n\n', // Double newlines (between blocks)
        '\n', // Single newlines
        '},', // JSON object boundaries
        '],', // JSON array boundaries
        '",', // JSON key-value boundaries
        ',', // General separators
        '}', // Closing braces
        ']', // Closing brackets
        ' ', // Spaces as last resort
        '', // Character-by-character fallback
      ];
      const structuredChunker = new RecursiveCharacterTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separators: structuredSeparators,
      });
      return [{ pieces: await structuredChunker.splitText(content), type: 'recursive' }];
    };

    let groups: ChunkGroup[] = [];
    let effectiveStrategy: ChunkingStrategy = options.strategy;
    let strategyNotified = false;
    const notifyStrategy = (strategy: ChunkingStrategy) => {
      if (strategyNotified) {
        return;
      }
      strategyNotified = true;
      options.onStrategyResolved?.(strategy);
    };

    const forceStrategy = options.forceStrategy === true;
    effectiveStrategy = resolveEffectiveStrategy({
      requested: options.strategy,
      forceStrategy,
      isMarkdown,
      isCode,
    });

    if (effectiveStrategy === 'token') {
      groups = await chunkTokens();
    } else if (effectiveStrategy === 'recursive') {
      groups = await chunkCode();
    } else if (isStructuredData) {
      // Use structured data splitter for JSON/XML/etc. instead of sentence splitter
      groups = await chunkStructuredData();
      effectiveStrategy = 'recursive'; // Update strategy to reflect actual method used
    } else {
      groups = isMarkdown ? await chunkMarkdown() : await chunkText();
    }
    notifyStrategy(effectiveStrategy);
    for (const g of groups) {
      yield* emit(g.pieces, g.type, effectiveMaxTokens);
    }
  }
}

function resolveEffectiveStrategy({
  requested,
  forceStrategy,
  isMarkdown,
  isCode,
}: {
  requested: ChunkingStrategy;
  forceStrategy: boolean;
  isMarkdown: boolean;
  isCode: boolean;
}): ChunkingStrategy {
  if (requested === 'token') {
    return 'token';
  }
  if (forceStrategy) {
    return requested;
  }
  if (isMarkdown) {
    return 'sentence';
  }
  if (requested === 'recursive' || isCode) {
    return 'recursive';
  }
  return 'sentence';
}

function resolveMaxTokensCap(cap?: number): number {
  if (!Number.isFinite(cap ?? Number.NaN)) {
    return CHUNKING_CONFIG.maxTokensSafetyCap;
  }
  const sanitized = Math.floor(cap as number);
  if (sanitized <= 0) {
    return CHUNKING_CONFIG.maxTokensSafetyCap;
  }
  return Math.max(256, Math.min(CHUNKING_CONFIG.maxTokensHardLimit, sanitized));
}

function isFunctionNode(type?: string): boolean {
  if (!type) {
    return false;
  }
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression' ||
    type === 'ObjectMethod' ||
    type === 'ClassMethod' ||
    type === 'ClassPrivateMethod' ||
    type === 'TSDeclareFunction' ||
    type === 'TSMethodSignature' ||
    type === 'TSCallSignatureDeclaration'
  );
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value && typeof value === 'object' && 'type' in (value as Record<string, unknown>)
  );
}

function isTopLevelContainerType(type?: string): boolean {
  return (
    type === 'Program' ||
    type === 'ExportNamedDeclaration' ||
    type === 'ExportDefaultDeclaration' ||
    type === 'ClassBody'
  );
}

function iterateAstChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          children.push(child);
        }
      }
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function collectTopLevelFunctionRanges(
  node: AstNode | null,
  ancestors: AstNode[],
  ranges: Array<{ start: number; end: number }>
): void {
  if (!node) {
    return;
  }

  const nodeType = node.type ?? '';
  const parentType = ancestors.at(-1)?.type;
  if (
    isTopLevelContainerType(parentType) &&
    isFunctionNode(nodeType) &&
    Number.isFinite(node.start) &&
    Number.isFinite(node.end)
  ) {
    ranges.push({ start: Number(node.start), end: Number(node.end) });
  }

  const nextAncestors = [...ancestors, node];
  for (const child of iterateAstChildren(node)) {
    collectTopLevelFunctionRanges(child, nextAncestors, ranges);
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

  const ranges: Array<{ start: number; end: number }> = [];
  collectTopLevelFunctionRanges(ast, [], ranges);

  if (!ranges.length) {
    return null;
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const pieces: string[] = [];
  let cursor = 0;

  const recursiveChunker = new RecursiveCharacterTextSplitter({
    chunkSize: maxChars,
    chunkOverlap: overlapChars,
    separators,
  });

  const pushSegment = async (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.length <= maxChars * 1.25) {
      pieces.push(trimmed);
      return;
    }
    const subPieces = await recursiveChunker.splitText(trimmed);
    pieces.push(...subPieces.map((p) => p.trim()).filter(Boolean));
  };

  const appendRange = async (startIndex: number, endIndex: number) => {
    const safeStart = Math.max(0, Math.min(startIndex, content.length));
    const safeEnd = Math.max(safeStart, Math.min(endIndex, content.length));
    await pushSegment(content.slice(safeStart, safeEnd));
  };

  for (const range of ranges) {
    const clampedStart = Math.max(0, Math.min(range.start, content.length));
    const clampedEnd = Math.max(clampedStart, Math.min(range.end, content.length));

    if (clampedStart > cursor) {
      await appendRange(cursor, clampedStart);
    }

    const paddedStart = Math.max(0, clampedStart - overlapChars);
    const paddedEnd = Math.min(content.length, clampedEnd + overlapChars);
    await appendRange(paddedStart, paddedEnd);
    cursor = clampedEnd;
  }

  if (cursor < content.length) {
    await appendRange(cursor, content.length);
  }

  return pieces;
}

// Utilities for streaming splitter
async function computeCharsPerToken(content: string, options: ChunkingOptions): Promise<number> {
  const counter = options.tokenCounter ?? (async (t: string) => countTokensAccurate(t));
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

function getCodeSeparators(custom?: string[]) {
  if (custom?.length) {
    return custom;
  }
  return [
    '\n\n',
    // Declarations and exports
    '\nexport default ',
    '\nexport class ',
    '\nclass ',
    '\nexport function ',
    '\nfunction ',
    '\nexport const ',
    '\nconst ',
    '\nlet ',
    '\nvar ',
    '\nexport interface ',
    '\ninterface ',
    '\ntype ',
    '\nimport ',
    // Test blocks and common structures
    '\ndescribe(',
    '\nit(',
    '\nelse ',
    '\ntry {',
    '\ncatch (',
    '\nfinally {',
    '\nswitch (',
    // Fallbacks
    '\n}',
    '\n};',
    '\n',
    ';',
    ',',
    ' ',
    '',
  ];
}

function splitByBlankLines(text: string): string[] {
  const parts: string[] = [];
  let buf: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') {
      if (buf.length) {
        parts.push(buf.join('\n'));
        buf = [];
      }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) {
    parts.push(buf.join('\n'));
  }
  return parts;
}

function splitMarkdownIntoBlocks(content: string) {
  interface Block {
    text: string;
    meta: { isFence?: boolean; heading?: string };
  }
  const blocks: Block[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const fence = captureFence(lines, i);
    if (fence.block) {
      blocks.push(fence.block);
      i = fence.consumed;
      continue;
    }

    const head = captureHeading(lines, i);
    if (head.heading) {
      blocks.push(head.heading);
      i = head.consumed;
      continue;
    }

    const para = captureParagraph(lines, i);
    if (para.paragraph) {
      blocks.push(para.paragraph);
    }
    i = para.consumed;
  }
  return blocks;
}

function captureFence(
  lines: (string | undefined)[],
  start: number
): { consumed: number; block?: { text: string; meta: { isFence: true } } } {
  const line = lines[start] ?? '';
  if (!/^```/.test(line)) {
    return { consumed: start };
  }
  const buf: string[] = [line];
  let i = start + 1;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (cur.startsWith('```')) {
      break;
    }
    buf.push(cur);
    i++;
  }
  if (i < lines.length) {
    buf.push(lines[i] ?? '');
    i++;
  }
  return { consumed: i, block: { text: buf.join('\n'), meta: { isFence: true } } };
}

function captureHeading(lines: (string | undefined)[], start: number) {
  const raw = lines[start] ?? '';
  const m = raw.match(/^(#{1,6})\s+(.*)$/);
  if (!m) {
    return { consumed: start } as const;
  }
  const headingText: string = m[2] ?? '';
  return { consumed: start + 1, heading: { text: raw, meta: { heading: headingText } } } as const;
}

function captureParagraph(lines: (string | undefined)[], start: number) {
  const buf: string[] = [];
  let i = start;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (cur.match(/^```/) || cur.match(/^(#{1,6})\s+/) || cur.trim() === '') {
      break;
    }
    buf.push(cur);
    i++;
  }
  if (buf.length === 0) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') {
      i++;
    }
    return { consumed: i } as const;
  }
  while (i < lines.length && (lines[i] ?? '').trim() === '') {
    i++;
  }
  return { consumed: i, paragraph: { text: buf.join('\n'), meta: {} as const } } as const;
}
