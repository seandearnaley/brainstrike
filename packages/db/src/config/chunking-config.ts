/**
 * Configuration constants for the chunking service
 */

export const CHUNKING_CONFIG = {
  // File size limits
  maxChunkableSize: 500 * 1024, // 500KB - Maximum file size for chunking

  // Default chunk parameters
  defaultMaxTokens: 500, // Default maximum tokens per chunk (reduced from 3000)
  defaultOverlap: 50, // Default overlap between chunks (reduced from 300)

  // Large structured file limits
  largeStructuredMaxTokens: 1500, // Smaller chunks for structured data
  largeStructuredOverlap: 150, // Overlap for structured data

  // Code-specific defaults (smaller chunks help retrieval for code)
  codeMaxTokens: 384,
  codeOverlap: 48,

  // Very large content thresholds and limits
  veryLargeContentThreshold: 100000, // 100KB+ threshold for very large content
  veryLargeMaxTokens: 1000, // Maximum tokens for very large content
  veryLargeOverlap: 100, // Overlap for very large content

  // Preview and display limits
  chunkPreviewLength: 50, // Characters to show in chunk preview
  csvContentPreviewLength: 100, // Characters to show in CSV export content preview

  // Token estimation constants
  averageCharsPerToken: 4, // Rough approximation of characters per token for English text

  // Timing constants
  embeddingInitializationDelay: 500, // Delay after embedding service initialization (ms)
  embeddingProcessingDelay: 10, // Delay between processing chunks (ms)
} as const;
