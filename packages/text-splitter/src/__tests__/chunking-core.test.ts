import { describe, expect, it } from 'vitest';
import { analyzeContentRepetition, shouldSkipChunking } from '../chunking-core.js';

describe('analyzeContentRepetition', () => {
  it('does not expose unavailable uniqueness counts below the analysis threshold', () => {
    const result = analyzeContentRepetition('x'.repeat(1_000_000));

    expect(result).toEqual({
      isHighlyRepetitive: false,
      kind: 'below-threshold',
      totalLines: 1,
    });
    expect('uniqueLines' in result).toBe(false);
  });

  it('preserves the strict unique-line ratio boundary including a trailing line', () => {
    const uniqueLines = Array.from({ length: 100 }, (_, index) => `unique-${index}`);
    const content = `${Array.from({ length: 901 }, () => 'duplicate').join(
      '\n'
    )}\n${uniqueLines.join('\n')}`;

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 1001,
      isHighlyRepetitive: false,
      kind: 'analyzed',
      totalLines: 1001,
      uniqueLines: 101,
    });
  });

  it('identifies generated content while retaining only distinct lines', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `generated-${index % 4}`).join(
      '\n'
    );

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 10_000,
      isHighlyRepetitive: true,
      kind: 'analyzed',
      totalLines: 10_000,
      uniqueLines: 4,
    });
    expect(shouldSkipChunking(content, {}, Number.POSITIVE_INFINITY)).toEqual({
      reason: 'Highly repetitive content (likely generated file)',
      skip: true,
    });
  });

  it('stops retaining unique lines once diversity proves content is not repetitive', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `unique-${index}`).join('\n');

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 1000,
      isHighlyRepetitive: false,
      kind: 'analyzed',
      totalLines: 10_000,
      uniqueLines: 1000,
    });
  });
});
