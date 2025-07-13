import {
  CharacterTextSplitter,
  RecursiveCharacterTextSplitter,
  TokenTextSplitter,
} from '@langchain/textsplitters';
import { CHUNKING_CONFIG } from '../config/chunking-config.js';
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

// Import the maximum file size from config
const { maxChunkableSize } = CHUNKING_CONFIG;

export class ChunkingService {
  async chunkContent(
    content: string,
    fileRecordId: string,
    options: ChunkingOptions = { strategy: 'sentence' }
  ): Promise<ChunkingResult> {
    console.log(`[CHUNKING DEBUG] Starting chunkContent for fileRecordId: ${fileRecordId}`);
    console.log(`[CHUNKING DEBUG] Content length: ${content?.length || 0}`);
    console.log('[CHUNKING DEBUG] Options:', options);

    if (!content || !fileRecordId) {
      console.error('[CHUNKING DEBUG] Missing required parameters:', {
        hasContent: !!content,
        fileRecordId,
      });
      throw new Error('Content and fileRecordId are required for chunking');
    }

    // Check if we should skip this file
    console.log('[CHUNKING DEBUG] Checking if file should be skipped');
    const skipResult = this.shouldSkipChunking(content, options);
    if (skipResult.skip) {
      console.log(`[CHUNKING DEBUG] File will be skipped: ${skipResult.reason}`);
      return {
        chunks: [],
        totalTokens: 0,
        avgTokensPerChunk: 0,
        skipped: true,
        skipReason: skipResult.reason || 'Unknown reason',
      };
    }

    const { strategy } = options;
    console.log(`[CHUNKING DEBUG] Using strategy: ${strategy}`);

    // Adjust chunking parameters based on file type and size
    const adjustedOptions = this.adjustChunkingForFileType(content, options);
    console.log('[CHUNKING DEBUG] Adjusted options:', adjustedOptions);

    // Use more generous character limits for modern embedding models
    // 1 token ≈ 4 characters for English text (standard GPT tokenization)
    const maxCharacters = Math.floor(adjustedOptions.maxTokens * 4);
    const overlapCharacters = Math.floor(adjustedOptions.overlap * 4);
    console.log(
      `[CHUNKING DEBUG] Character limits - max: ${maxCharacters}, overlap: ${overlapCharacters}`
    );

    let chunkTexts: string[];
    let chunkType: 'text' | 'code' | 'sentence' | 'recursive';

    try {
      console.log(`[CHUNKING DEBUG] Starting chunking with strategy: ${strategy}`);
      switch (strategy) {
        case 'sentence': {
          // Use CharacterTextSplitter with conservative limits for sentences
          const sentenceChunker = new CharacterTextSplitter({
            chunkSize: maxCharacters,
            chunkOverlap: overlapCharacters,
            separator: '. ',
          });
          console.log(
            `[CHUNKING DEBUG] Creating sentence chunker with chunk size: ${maxCharacters}, overlap: ${overlapCharacters}`
          );
          chunkTexts = await sentenceChunker.splitText(content);
          chunkType = 'sentence';
          console.log(
            `[CHUNKING DEBUG] Sentence chunking completed - got ${chunkTexts.length} chunks`
          );
          break;
        }

        case 'token': {
          // Use TokenTextSplitter with conservative token limits
          const tokenChunker = new TokenTextSplitter({
            chunkSize: adjustedOptions.maxTokens,
            chunkOverlap: adjustedOptions.overlap,
          });
          console.log(
            `[CHUNKING DEBUG] Creating token chunker with chunk size: ${adjustedOptions.maxTokens}, overlap: ${adjustedOptions.overlap}`
          );
          chunkTexts = await tokenChunker.splitText(content);
          chunkType = 'text'; // Token strategy produces text chunks
          console.log(
            `[CHUNKING DEBUG] Token chunking completed - got ${chunkTexts.length} chunks`
          );
          break;
        }

        case 'recursive': {
          // Enhanced separators for code content, prioritizing TypeScript/JavaScript syntax
          const codeSeparators = [
            '\n\n', // Paragraph breaks (blank lines)

            // TypeScript/JavaScript specific patterns
            '\nexport class ', // Class exports
            '\nclass ', // Class definitions
            '\nexport function ', // Function exports
            '\nfunction ', // Function definitions
            '\nexport const ', // Const exports
            '\nconst ', // Const declarations
            '\nlet ', // Let declarations
            '\nvar ', // Var declarations
            '\nexport interface ', // Interface exports
            '\ninterface ', // Interface definitions
            '\ntype ', // Type definitions
            '\nimport ', // Import statements

            // Control structures
            '\nif (', // Conditional blocks
            '\nfor (', // For loops
            '\nwhile (', // While loops
            '\ntry {', // Try blocks
            '\ncatch (', // Catch blocks
            '\nfinally {', // Finally blocks
            '\nswitch (', // Switch statements

            // Code blocks and separators
            '\n}', // End of blocks
            '\n};', // End of object/interface
            '\n', // Line breaks
            ';', // Statement ends
            ',', // Comma separators
            ' ', // Word boundaries
            '', // Character boundaries
          ];

          // Use RecursiveCharacterTextSplitter with conservative character limits
          const recursiveChunker = new RecursiveCharacterTextSplitter({
            chunkSize: maxCharacters,
            chunkOverlap: overlapCharacters,
            separators: options.separators || codeSeparators,
          });
          console.log(
            `[CHUNKING DEBUG] Creating recursive chunker with chunk size: ${maxCharacters}, overlap: ${overlapCharacters}`
          );
          chunkTexts = await recursiveChunker.splitText(content);
          chunkType = 'recursive';
          console.log(
            `[CHUNKING DEBUG] Recursive chunking completed - got ${chunkTexts.length} chunks`
          );
          break;
        }

        default: {
          console.error(`[CHUNKING DEBUG] Unsupported chunking strategy: ${strategy}`);
          throw new Error(`Unsupported chunking strategy: ${strategy}`);
        }
      }
    } catch (error) {
      console.error('[CHUNKING DEBUG] Chunking strategy execution failed:', error);
      throw new Error(
        `Chunking failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    console.log(`[CHUNKING DEBUG] Starting chunk processing for ${chunkTexts.length} chunks`);
    return await this.processChunks(chunkTexts, fileRecordId, chunkType, adjustedOptions.maxTokens);
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
    if (content.length > maxChunkableSize) {
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

    // Use much smaller default chunk sizes appropriate for code and text
    let maxTokens = options.maxTokens || CHUNKING_CONFIG.defaultMaxTokens;
    let overlap = options.overlap || CHUNKING_CONFIG.defaultOverlap;

    // For large structured files, use smaller chunks
    for (const pattern of LARGE_STRUCTURED_PATTERNS) {
      if (pattern.test(fileName)) {
        maxTokens = Math.min(maxTokens, CHUNKING_CONFIG.largeStructuredMaxTokens);
        overlap = Math.min(overlap, CHUNKING_CONFIG.largeStructuredOverlap);
        break;
      }
    }

    // For very large content, use even smaller chunks
    if (content.length > CHUNKING_CONFIG.veryLargeContentThreshold) {
      maxTokens = Math.min(maxTokens, CHUNKING_CONFIG.veryLargeMaxTokens);
      overlap = Math.min(overlap, CHUNKING_CONFIG.veryLargeOverlap);
    }

    return { maxTokens, overlap };
  }

  private async processChunks(
    chunkTexts: string[],
    fileRecordId: string,
    chunkType: 'text' | 'code' | 'sentence' | 'recursive',
    maxTokens: number
  ): Promise<ChunkingResult> {
    const chunks: FileChunkInsert[] = [];
    let totalTokens = 0;

    for (let i = 0; i < chunkTexts.length; i++) {
      const content = chunkTexts[i];
      if (!content?.trim()) continue;

      const estimatedTokens = this.estimateTokenCount(content);

      // Note: We no longer log warnings for large chunks as they're handled by skipping logic above

      const contentHash = await this.generateContentHash(content);
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

  private async generateContentHash(content: string): Promise<string> {
    // Use the proper crypto utility for content hashing
    const { generateContentHash } = await import('@brainstrike/utils');
    return generateContentHash(content);
  }

  async dispose(): Promise<void> {
    // Clean up any resources (no longer needed as we create splitters on-demand)
  }
}
