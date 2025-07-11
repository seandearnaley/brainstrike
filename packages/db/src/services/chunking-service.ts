import {
  CharacterTextSplitter,
  RecursiveCharacterTextSplitter,
  TokenTextSplitter,
} from '@langchain/textsplitters';
import type { FileChunkInsert } from '../models/file-chunk';

export type ChunkingStrategy = 'sentence' | 'token' | 'recursive';

export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxTokens?: number;
  overlap?: number;
  separators?: string[];
  fileName?: string;
  filePath?: string;
}

export interface ChunkingResult {
  chunks: FileChunkInsert[];
  totalTokens: number;
  avgTokensPerChunk: number;
  skipped?: boolean;
  skipReason?: string;
}

// File patterns that should be skipped or handled differently
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

// Maximum file size for chunking (500KB)
const MAX_CHUNKABLE_SIZE = 500 * 1024;

export class ChunkingService {
  async chunkContent(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'sentence' }
  ): Promise<ChunkingResult> {
    if (!content || !fileRecordId) {
      throw new Error('Content and fileRecordId are required for chunking');
    }

    // Check if we should skip this file
    const skipResult = this.shouldSkipChunking(content, options);
    if (skipResult.skip) {
      return {
        chunks: [],
        totalTokens: 0,
        avgTokensPerChunk: 0,
        skipped: true,
        skipReason: skipResult.reason || 'Unknown reason',
      };
    }

    const { strategy } = options;

    // Adjust chunking parameters based on file type and size
    const adjustedOptions = this.adjustChunkingForFileType(content, options);

    // Use more generous character limits for modern embedding models
    // 1 token ≈ 4 characters for English text (standard GPT tokenization)
    const maxCharacters = Math.floor(adjustedOptions.maxTokens * 4);
    const overlapCharacters = Math.floor(adjustedOptions.overlap * 4);

    let chunkTexts: string[];
    let chunkType: 'text' | 'code' | 'sentence' | 'recursive';

    try {
      switch (strategy) {
        case 'sentence': {
          // Use CharacterTextSplitter with conservative limits for sentences
          const sentenceChunker = new CharacterTextSplitter({
            chunkSize: maxCharacters,
            chunkOverlap: overlapCharacters,
            separator: '. ',
          });
          chunkTexts = await sentenceChunker.splitText(content);
          chunkType = 'sentence';
          break;
        }

        case 'token': {
          // Use TokenTextSplitter with conservative token limits
          const tokenChunker = new TokenTextSplitter({
            chunkSize: adjustedOptions.maxTokens,
            chunkOverlap: adjustedOptions.overlap,
          });
          chunkTexts = await tokenChunker.splitText(content);
          chunkType = 'text';
          break;
        }

        case 'recursive': {
          // Enhanced separators for code content with conservative character limits
          const codeSeparators = [
            '\n\n', // Paragraph breaks
            '\nclass ', // Class definitions
            '\ndef ', // Function definitions
            '\nif ', // Conditional blocks
            '\nfor ', // Loop blocks
            '\nwhile ', // Loop blocks
            '\ntry ', // Exception blocks
            '\n', // Line breaks
            '. ', // Sentence ends
            '; ', // Statement ends
            ', ', // Comma pauses
            ' ', // Word boundaries
            '', // Character boundaries
          ];

          // Use RecursiveCharacterTextSplitter with conservative character limits
          const recursiveChunker = new RecursiveCharacterTextSplitter({
            chunkSize: maxCharacters,
            chunkOverlap: overlapCharacters,
            separators: options.separators || codeSeparators,
          });
          chunkTexts = await recursiveChunker.splitText(content);
          chunkType = 'recursive';
          break;
        }

        default: {
          throw new Error(`Unsupported chunking strategy: ${strategy}`);
        }
      }
    } catch (error) {
      throw new Error(
        `Chunking failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    return this.processChunks(chunkTexts, fileRecordId, chunkType, adjustedOptions.maxTokens);
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

    // Check content size
    if (content.length > MAX_CHUNKABLE_SIZE) {
      return {
        skip: true,
        reason: `File too large: ${Math.round(content.length / 1024)}KB (max: ${Math.round(
          MAX_CHUNKABLE_SIZE / 1024
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
    let maxTokens = options.maxTokens || 3000;
    let overlap = options.overlap || 300;

    // For large structured files, use smaller chunks
    for (const pattern of LARGE_STRUCTURED_PATTERNS) {
      if (pattern.test(fileName)) {
        maxTokens = Math.min(maxTokens, 1500); // Smaller chunks for structured data
        overlap = Math.min(overlap, 150);
        break;
      }
    }

    // For very large content, use even smaller chunks
    if (content.length > 100000) {
      // 100KB+
      maxTokens = Math.min(maxTokens, 1000);
      overlap = Math.min(overlap, 100);
    }

    return { maxTokens, overlap };
  }

  private processChunks(
    chunkTexts: string[],
    fileRecordId: string,
    chunkType: 'text' | 'code' | 'sentence' | 'recursive',
    maxTokens: number
  ): ChunkingResult {
    const chunks: FileChunkInsert[] = [];
    let totalTokens = 0;

    for (let i = 0; i < chunkTexts.length; i++) {
      const content = chunkTexts[i];
      if (!content?.trim()) continue;

      const estimatedTokens = this.estimateTokenCount(content);

      // Note: We no longer log warnings for large chunks as they're handled by skipping logic above

      const contentHash = this.generateContentHash(content);
      const now = new Date().toISOString();
      const chunkId = `${fileRecordId}_chunk_${i}`;

      chunks.push({
        id: chunkId,
        fileRecordId: fileRecordId,
        chunkIndex: i,
        content,
        contentHash: contentHash,
        tokenCount: estimatedTokens,
        chunkType: chunkType,
        chunkSize: maxTokens,
        createdAt: now,
        updatedAt: now,
      });

      totalTokens += estimatedTokens;
    }

    const avgTokensPerChunk = chunks.length > 0 ? totalTokens / chunks.length : 0;

    return {
      chunks,
      totalTokens,
      avgTokensPerChunk,
    };
  }

  private estimateTokenCount(text: string): number {
    // Standard token estimation for embeddings
    // Use the standard estimate: 1 token ≈ 4 characters (GPT tokenization)
    const charCount = text.length;
    return Math.ceil(charCount / 4);
  }

  private generateContentHash(content: string): string {
    // Simple hash function for content
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  async dispose(): Promise<void> {
    // Clean up any resources (no longer needed as we create splitters on-demand)
  }
}
