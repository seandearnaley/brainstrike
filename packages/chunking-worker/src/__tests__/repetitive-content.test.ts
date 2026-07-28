import { describe, expect, it } from 'vitest';
import { analyzeContentRepetition } from '../repetitive-content';

describe('analyzeContentRepetition', () => {
  it('preserves the strict unique-line ratio boundary including a trailing line', () => {
    const lines = Array.from({ length: 100 }, (_, index) => `unique-${index}`);
    const content = `${Array.from({ length: 901 }, () => 'duplicate').join('\n')}\n${lines.join(
      '\n'
    )}`;

    const result = analyzeContentRepetition(content);

    expect(result.totalLines).toBe(1001);
    expect(result.uniqueLines).toBe(101);
    expect(result.isHighlyRepetitive).toBe(false);
  });

  it('identifies generated content without materializing an array of all lines', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `generated-${index % 4}`).join(
      '\n'
    );

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 10_000,
      isHighlyRepetitive: true,
      totalLines: 10_000,
      uniqueLines: 4,
    });
  });

  it('stops retaining unique lines once diversity proves content is not repetitive', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `unique-${index}`).join('\n');

    const result = analyzeContentRepetition(content);

    expect(result).toEqual({
      inspectedLines: 1000,
      isHighlyRepetitive: false,
      totalLines: 10_000,
      uniqueLines: 1000,
    });
  });
});
