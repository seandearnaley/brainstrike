/**
 * Configuration constants for the chunking service
 */

export const CHUNKING_CONFIG = {
  // Token estimation constants
  averageCharsPerToken: 4, // Rough approximation of characters per token for English text

  // Preview and display limits
  chunkPreviewLength: 50, // Characters to show in chunk preview

  // Language-aware defaults (override codeMaxTokens/codeOverlap when extension matches)
  codeLanguageDefaults: {
    cpp: { maxTokens: 640, overlap: 72 },
    csharp: { maxTokens: 640, overlap: 72 },
    go: { maxTokens: 640, overlap: 72 },
    java: { maxTokens: 640, overlap: 72 },
    javascript: { maxTokens: 512, overlap: 64 },
    kotlin: { maxTokens: 640, overlap: 72 },
    php: { maxTokens: 512, overlap: 64 },
    python: { maxTokens: 512, overlap: 50 },
    ruby: { maxTokens: 512, overlap: 64 },
    rust: { maxTokens: 768, overlap: 75 },
    swift: { maxTokens: 640, overlap: 72 },
    typescript: { maxTokens: 512, overlap: 64 },
  } as const,

  // Code-specific defaults (smaller chunks help retrieval for code)
  codeMaxTokens: 384,
  codeOverlap: 48,
  csvContentPreviewLength: 100, // Characters to show in CSV export content preview

  // Default chunk parameters
  defaultMaxTokens: 500, // Default maximum tokens per chunk (reduced from 3000)
  defaultOverlap: 50, // Default overlap between chunks (reduced from 300)

  // Timing constants
  embeddingInitializationDelay: 500, // Delay after embedding service initialization (ms)
  embeddingProcessingDelay: 10, // Delay between processing chunks (ms)

  // Large structured file limits
  largeStructuredMaxTokens: 1500, // Smaller chunks for structured data
  largeStructuredOverlap: 150, // Overlap for structured data
  maxBatchSize: 500, // Maximum chunk requests accepted in a single batch message
  // File size limits
  maxChunkableSize: 500 * 1024, // 500KB - Maximum file size for chunking

  // Safety caps applied when callers provide explicit chunk sizes
  maxTokensHardLimit: 6000,

  // Global safety caps to guard against extreme inputs
  maxTokensSafetyCap: 4096, // Hard ceiling for chunk size regardless of source
  overlapHardLimit: 2000,
  overlapSafetyCap: 1024, // Hard ceiling for overlap to avoid runaway duplication

  // Very large content thresholds and limits
  veryLargeContentThreshold: 100_000, // 100KB+ threshold for very large content
  veryLargeMaxTokens: 1000, // Maximum tokens for very large content
  veryLargeOverlap: 100, // Overlap for very large content
} as const;
