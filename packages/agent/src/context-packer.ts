import { countTokensHeuristic } from '@brainstrike/utils';

type OffsetRange = {
  start?: number;
  end?: number;
};

export type ContextPackerChunk = {
  id: string;
  content: string;
  tokenCount?: number | null;
  filePath?: string;
  fileName?: string;
  chunkIndex?: number;
  startOffset?: number;
  endOffset?: number;
  score?: number;
  metadata?: Record<string, unknown>;
};

export type PackedContextChunk = {
  id: string;
  content: string;
  tokenCount: number;
  filePath?: string;
  fileName?: string;
  chunkIndex?: number;
  offsets?: OffsetRange;
  score?: number;
  metadata?: Record<string, unknown>;
  rank: number;
};

export type ContextPackerResult = {
  chunks: readonly PackedContextChunk[];
  totalTokens: number;
  budget: number;
  remainingTokens: number;
  skipped: number;
};

/**
 * Options for configuring how context is packed into the budget.
 */
export type ContextPackerOptions = {
  budgetTokens: number;
  maxChunks?: number;
  estimateTokens?: (content: string) => number;
};

function normalizeTokenCount(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return;
  }
  if (value <= 0) {
    return;
  }
  return Math.ceil(value);
}

function resolveOffsets(chunk: ContextPackerChunk): OffsetRange | undefined {
  if (chunk.startOffset === undefined && chunk.endOffset === undefined) {
    return;
  }
  const offsets: OffsetRange = {};
  if (chunk.startOffset !== undefined) {
    offsets.start = chunk.startOffset;
  }
  if (chunk.endOffset !== undefined) {
    offsets.end = chunk.endOffset;
  }
  return offsets;
}

function resolveTokenCount(
  chunk: ContextPackerChunk,
  estimateTokens: (content: string) => number
): number {
  const normalized = normalizeTokenCount(chunk.tokenCount ?? undefined);
  if (normalized !== undefined) {
    return normalized;
  }
  const estimated = estimateTokens(chunk.content);
  const normalizedEstimate = normalizeTokenCount(estimated);
  return normalizedEstimate ?? 0;
}

function assertValidChunk(chunk: ContextPackerChunk): void {
  if (typeof chunk.id !== 'string' || chunk.id.trim().length === 0) {
    throw new Error('ContextPacker: chunk id must be a non-empty string.');
  }
  if (typeof chunk.content !== 'string') {
    throw new Error('ContextPacker: chunk content must be a string.');
  }
}

function shouldSkipForBudget(
  tokenCount: number,
  totalTokens: number,
  budgetTokens: number
): boolean {
  if (tokenCount <= 0) {
    return false;
  }
  return totalTokens + tokenCount > budgetTokens;
}

function buildPackedChunk(
  chunk: ContextPackerChunk,
  tokenCount: number,
  rank: number
): PackedContextChunk {
  const offsets = resolveOffsets(chunk);
  const packed: PackedContextChunk = {
    id: chunk.id,
    content: chunk.content,
    tokenCount,
    rank,
  };

  if (chunk.filePath !== undefined) {
    packed.filePath = chunk.filePath;
  }
  if (chunk.fileName !== undefined) {
    packed.fileName = chunk.fileName;
  }
  if (chunk.chunkIndex !== undefined) {
    packed.chunkIndex = chunk.chunkIndex;
  }
  if (offsets) {
    packed.offsets = offsets;
  }
  if (chunk.score !== undefined) {
    packed.score = chunk.score;
  }
  if (chunk.metadata !== undefined) {
    packed.metadata = chunk.metadata;
  }

  return packed;
}

/**
 * Pack candidate context chunks into a token budget while preserving order and metadata.
 *
 * @example
 * const packer = new ContextPacker({ budgetTokens: 4000 });
 * const result = packer.pack(chunks);
 */
export class ContextPacker {
  private readonly budgetTokens: number;
  private readonly maxChunks: number | undefined;
  private readonly estimateTokens: (content: string) => number;

  constructor(options: ContextPackerOptions) {
    if (!Number.isFinite(options.budgetTokens) || options.budgetTokens < 0) {
      throw new Error(
        `ContextPacker: budgetTokens must be a finite non-negative number, got ${options.budgetTokens}`
      );
    }
    const budgetTokens = Math.floor(options.budgetTokens);
    if (!Number.isSafeInteger(budgetTokens)) {
      throw new Error(
        `ContextPacker: budgetTokens exceeds safe integer range (${Number.MAX_SAFE_INTEGER})`
      );
    }
    this.budgetTokens = Math.max(0, budgetTokens);
    this.maxChunks = options.maxChunks;
    this.estimateTokens = options.estimateTokens ?? countTokensHeuristic;
  }

  /**
   * Select chunks that fit within the configured budget and max chunk limit.
   */
  pack(chunks: readonly ContextPackerChunk[]): ContextPackerResult {
    const packed: PackedContextChunk[] = [];
    let totalTokens = 0;
    let skipped = 0;
    const maxChunks = this.maxChunks ?? Number.POSITIVE_INFINITY;

    for (const [index, chunk] of chunks.entries()) {
      assertValidChunk(chunk);
      if (packed.length >= maxChunks) {
        skipped += 1;
        continue;
      }

      const tokenCount = resolveTokenCount(chunk, this.estimateTokens);
      if (shouldSkipForBudget(tokenCount, totalTokens, this.budgetTokens)) {
        skipped += 1;
        if (this.budgetTokens > 0 && totalTokens >= this.budgetTokens) {
          const remaining = chunks.length - index - 1;
          if (remaining > 0) {
            skipped += remaining;
          }
          break;
        }
        continue;
      }

      packed.push(buildPackedChunk(chunk, tokenCount, packed.length + 1));
      totalTokens += tokenCount;
    }

    const remainingTokens = Math.max(0, this.budgetTokens - totalTokens);
    return {
      chunks: packed,
      totalTokens,
      budget: this.budgetTokens,
      remainingTokens,
      skipped,
    };
  }
}
