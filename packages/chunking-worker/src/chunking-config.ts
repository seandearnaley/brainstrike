/**
 * Configuration constants for the chunking worker.
 * This is a portable version of the chunking config that can run in a worker.
 */

export const CHUNKING_CONFIG = {
  // File size limits
  maxChunkableSize: 500 * 1024, // 500KB - Maximum file size for chunking
  maxBatchSize: 500, // Maximum chunk requests accepted in a single batch message
  maxMetadataFieldLength: 4096, // Hard limit for request metadata strings (ids, names, paths)
  maxSeparatorsCount: 64, // Hard limit for custom separator arrays passed into the worker

  // Default chunk parameters
  defaultMaxTokens: 500, // Default maximum tokens per chunk
  defaultOverlap: 50, // Default overlap between chunks

  // Large structured file limits
  largeStructuredMaxTokens: 1500, // Smaller chunks for structured data
  largeStructuredOverlap: 150, // Overlap for structured data

  // Code-specific defaults (smaller chunks help retrieval for code)
  codeMaxTokens: 384,
  codeOverlap: 48,

  // Language-aware defaults (override codeMaxTokens/codeOverlap when extension matches)
  codeLanguageDefaults: {
    javascript: { maxTokens: 512, overlap: 64 },
    typescript: { maxTokens: 512, overlap: 64 },
    python: { maxTokens: 512, overlap: 50 },
    rust: { maxTokens: 768, overlap: 75 },
    go: { maxTokens: 640, overlap: 72 },
    java: { maxTokens: 640, overlap: 72 },
    csharp: { maxTokens: 640, overlap: 72 },
    cpp: { maxTokens: 640, overlap: 72 },
    ruby: { maxTokens: 512, overlap: 64 },
    php: { maxTokens: 512, overlap: 64 },
    swift: { maxTokens: 640, overlap: 72 },
    kotlin: { maxTokens: 640, overlap: 72 },
  } as const,

  // Safety caps applied when callers provide explicit chunk sizes
  maxTokensHardLimit: 6000,
  overlapHardLimit: 2000,

  // Very large content thresholds and limits
  veryLargeContentThreshold: 100_000, // 100KB+ threshold for very large content
  veryLargeMaxTokens: 1000, // Maximum tokens for very large content
  veryLargeOverlap: 100, // Overlap for very large content

  // Global safety caps to guard against extreme inputs
  maxTokensSafetyCap: 4096, // Hard ceiling for chunk size regardless of source
  overlapSafetyCap: 1024, // Hard ceiling for overlap to avoid runaway duplication

  // Token estimation constants
  averageCharsPerToken: 4, // Fallback chars/token ratio if estimator calibration cannot run
} as const;

export type CodeLanguage = keyof typeof CHUNKING_CONFIG.codeLanguageDefaults;
