import { describe, expect, it } from 'vitest';
import { CHUNKING_CONFIG } from '../src/config/chunking-config';

describe('CHUNKING_CONFIG', () => {
  it('should have correct file size limits', () => {
    expect(CHUNKING_CONFIG.maxChunkableSize).toBe(500 * 1024);
    expect(CHUNKING_CONFIG.maxBatchSize).toBe(500);
  });

  it('should have correct default chunk parameters', () => {
    expect(CHUNKING_CONFIG.defaultMaxTokens).toBe(500);
    expect(CHUNKING_CONFIG.defaultOverlap).toBe(50);
  });

  it('should have correct large structured file limits', () => {
    expect(CHUNKING_CONFIG.largeStructuredMaxTokens).toBe(1500);
    expect(CHUNKING_CONFIG.largeStructuredOverlap).toBe(150);
  });

  it('should expose language-aware code defaults', () => {
    expect(CHUNKING_CONFIG.codeLanguageDefaults.typescript.maxTokens).toBe(512);
    expect(CHUNKING_CONFIG.codeLanguageDefaults.rust.overlap).toBe(75);
  });

  it('should have correct very large content thresholds', () => {
    expect(CHUNKING_CONFIG.veryLargeContentThreshold).toBe(100_000);
    expect(CHUNKING_CONFIG.veryLargeMaxTokens).toBe(1000);
    expect(CHUNKING_CONFIG.veryLargeOverlap).toBe(100);
  });

  it('should expose safety caps for explicit overrides', () => {
    expect(CHUNKING_CONFIG.maxTokensHardLimit).toBe(6000);
    expect(CHUNKING_CONFIG.overlapHardLimit).toBe(2000);
    expect(CHUNKING_CONFIG.maxTokensSafetyCap).toBe(4096);
    expect(CHUNKING_CONFIG.overlapSafetyCap).toBe(1024);
  });

  it('should have correct preview lengths', () => {
    expect(CHUNKING_CONFIG.chunkPreviewLength).toBe(50);
    expect(CHUNKING_CONFIG.csvContentPreviewLength).toBe(100);
  });

  it('should have correct token estimation constant', () => {
    expect(CHUNKING_CONFIG.averageCharsPerToken).toBe(4);
  });

  it('should have correct timing constants', () => {
    expect(CHUNKING_CONFIG.embeddingInitializationDelay).toBe(500);
    expect(CHUNKING_CONFIG.embeddingProcessingDelay).toBe(10);
  });

  it('should have all expected properties', () => {
    const expectedKeys = [
      'maxChunkableSize',
      'maxBatchSize',
      'defaultMaxTokens',
      'defaultOverlap',
      'largeStructuredMaxTokens',
      'largeStructuredOverlap',
      'codeMaxTokens',
      'codeOverlap',
      'codeLanguageDefaults',
      'maxTokensHardLimit',
      'overlapHardLimit',
      'veryLargeContentThreshold',
      'veryLargeMaxTokens',
      'veryLargeOverlap',
      'maxTokensSafetyCap',
      'overlapSafetyCap',
      'chunkPreviewLength',
      'csvContentPreviewLength',
      'averageCharsPerToken',
      'embeddingInitializationDelay',
      'embeddingProcessingDelay',
    ];

    expect(Object.keys(CHUNKING_CONFIG).sort()).toEqual(expectedKeys.sort());
  });
});
