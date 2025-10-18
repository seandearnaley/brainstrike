import { countTokensAccurate, createLogger } from '@brainstrike/utils';
import {
  CharacterTextSplitter,
  RecursiveCharacterTextSplitter,
  TokenTextSplitter,
} from '@langchain/textsplitters';
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
  // Notify caller which strategy was actually used after file/extension heuristics
  onStrategyResolved?: (strategy: ChunkingStrategy) => void;
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

    if (!content || !fileRecordId) {
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

    // Adjust chunking parameters based on file type and size
    const adjustedOptions = this.adjustChunkingForFileType(content, options);

    // Collect by iterating the streaming API to minimize additional memory
    const chunks: FileChunkInsert[] = [];
    let totalTokens = 0;
    let idx = 0;
    for await (const chunk of this.chunkContentStream(content, fileRecordId, {
      ...options,
      maxTokens: adjustedOptions.maxTokens,
      overlap: adjustedOptions.overlap,
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

    const requestedMaxTokens = options.maxTokens;
    const requestedOverlap = options.overlap;
    const hasCustomMaxTokens = requestedMaxTokens !== undefined;
    const hasCustomOverlap = requestedOverlap !== undefined;

    const normalize = (value: number | undefined, fallback: number, minimum: number): number => {
      const candidate = Number.isFinite(value) ? (value as number) : fallback;
      return Math.max(minimum, Math.floor(candidate));
    };

    // Normalize inputs to sane integer values
    let maxTokens = normalize(requestedMaxTokens, CHUNKING_CONFIG.defaultMaxTokens, 1);
    let overlap = normalize(requestedOverlap, CHUNKING_CONFIG.defaultOverlap, 0);

    const applyRecommendation = (recommendedMax: number, recommendedOverlap: number) => {
      if (!hasCustomMaxTokens) {
        maxTokens = Math.min(maxTokens, recommendedMax);
      }
      if (!hasCustomOverlap) {
        overlap = Math.min(overlap, recommendedOverlap);
      }
    };

    // Prefer smaller chunks for code files (improves semantic retrieval)
    const isCode =
      /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|rs|go|py|java|kt|cs|rb|php|cpp|c|h|m|mm|swift)$/.test(
        fileName.toLowerCase()
      );
    if (isCode) {
      applyRecommendation(CHUNKING_CONFIG.codeMaxTokens, CHUNKING_CONFIG.codeOverlap);
    }

    // For large structured files, use smaller chunks
    for (const pattern of LARGE_STRUCTURED_PATTERNS) {
      if (pattern.test(fileName)) {
        applyRecommendation(
          CHUNKING_CONFIG.largeStructuredMaxTokens,
          CHUNKING_CONFIG.largeStructuredOverlap
        );
        break;
      }
    }

    // For very large content, use even smaller chunks
    if (content.length > CHUNKING_CONFIG.veryLargeContentThreshold) {
      applyRecommendation(CHUNKING_CONFIG.veryLargeMaxTokens, CHUNKING_CONFIG.veryLargeOverlap);
    }

    maxTokens = Math.min(maxTokens, CHUNKING_CONFIG.maxTokensSafetyCap);
    overlap = Math.min(overlap, CHUNKING_CONFIG.overlapSafetyCap);
    overlap = Math.min(overlap, Math.max(0, maxTokens - 1));

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
   * Streaming chunk production to reduce peak memory.
   * Yields FileChunkInsert items without materializing a large array.
   */
  async *chunkContentStream(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'sentence' }
  ): AsyncGenerator<FileChunkInsert> {
    if (!content || !fileRecordId) {
      throw new Error('Content and fileRecordId are required for chunking');
    }

    const adjusted = this.adjustChunkingForFileType(content, options);
    const nowIso = () => new Date().toISOString();

    let seq = 0;
    const emit = async function* (
      this: ChunkingService,
      pieces: string[],
      chunkType: FileChunkInsert['chunkType'],
      maxTokens: number
    ): AsyncGenerator<FileChunkInsert> {
      for (const txt of pieces) {
        const c = txt?.trim();
        if (!c) continue;
        const tokenCount = options.tokenCounter
          ? await options.tokenCounter(c)
          : this.estimateTokenCount(c);
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

    const maxChars = Math.floor(adjusted.maxTokens * charsPerToken);
    const overlapChars = Math.floor(adjusted.overlap * charsPerToken);

    const name = (options.fileName || options.filePath || '').toLowerCase();
    const isMarkdown = /\.(md|mdx|markdown)$/.test(name);
    const isCode = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|rs|go|py|java|kt|cs|rb|php)$/.test(name);

    type ChunkGroup = { pieces: string[]; type: FileChunkInsert['chunkType'] };

    const chunkTokens = async (): Promise<ChunkGroup[]> => {
      const tokenChunker = new TokenTextSplitter({
        chunkSize: adjusted.maxTokens,
        chunkOverlap: adjusted.overlap,
      });
      return [{ pieces: await tokenChunker.splitText(content), type: 'text' }];
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
          const sentenceChunker = new CharacterTextSplitter({
            chunkSize: maxChars,
            chunkOverlap: overlapChars,
            separator: '. ',
          });
          groups.push({ pieces: await sentenceChunker.splitText(block.text), type: 'sentence' });
        }
      }
      return groups;
    };

    const chunkMarkdown = async (): Promise<ChunkGroup[]> => splitMarkdownBlocks();

    const chunkCode = async (): Promise<ChunkGroup[]> => {
      const codeSeparators = getCodeSeparators(options.separators);
      const recursiveChunker = new RecursiveCharacterTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separators: codeSeparators,
      });
      return [{ pieces: await recursiveChunker.splitText(content), type: 'recursive' }];
    };

    const chunkText = async (): Promise<ChunkGroup[]> => {
      const sentenceChunker = new CharacterTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separator: '. ',
      });
      return [{ pieces: await sentenceChunker.splitText(content), type: 'sentence' }];
    };

    let groups: ChunkGroup[] = [];
    let effectiveStrategy: ChunkingStrategy = options.strategy;
    let strategyNotified = false;
    const notifyStrategy = (strategy: ChunkingStrategy) => {
      if (strategyNotified) return;
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
    } else {
      groups = isMarkdown ? await chunkMarkdown() : await chunkText();
    }
    notifyStrategy(effectiveStrategy);
    for (const g of groups) {
      yield* emit(g.pieces, g.type, adjusted.maxTokens);
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
  if (requested === 'token') return 'token';
  if (forceStrategy) return requested;
  if (isMarkdown) return 'sentence';
  if (requested === 'recursive' || isCode) return 'recursive';
  return 'sentence';
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
  } catch (_err) {
    // ignore
  }
  return Number(CHUNKING_CONFIG.averageCharsPerToken);
}

function getCodeSeparators(custom?: string[]) {
  if (custom?.length) return custom;
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
  if (buf.length) parts.push(buf.join('\n'));
  return parts;
}

function splitMarkdownIntoBlocks(content: string) {
  type Block = { text: string; meta: { isFence?: boolean; heading?: string } };
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
    if (para.paragraph) blocks.push(para.paragraph);
    i = para.consumed;
  }
  return blocks;
}

function captureFence(
  lines: (string | undefined)[],
  start: number
): { consumed: number; block?: { text: string; meta: { isFence: true } } } {
  const line = lines[start] ?? '';
  if (!/^```/.test(line)) return { consumed: start };
  const buf: string[] = [line];
  let i = start + 1;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (cur.startsWith('```')) break;
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
  if (!m) return { consumed: start } as const;
  const headingText: string = m[2] ?? '';
  return { consumed: start + 1, heading: { text: raw, meta: { heading: headingText } } } as const;
}

function captureParagraph(lines: (string | undefined)[], start: number) {
  const buf: string[] = [];
  let i = start;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (cur.match(/^```/) || cur.match(/^(#{1,6})\s+/) || cur.trim() === '') break;
    buf.push(cur);
    i++;
  }
  if (buf.length === 0) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
    return { consumed: i } as const;
  }
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
  return { consumed: i, paragraph: { text: buf.join('\n'), meta: {} as const } } as const;
}
