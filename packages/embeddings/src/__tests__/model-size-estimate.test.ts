import { describe, expect, it } from 'vitest';
import { parseModelSizeEstimateBytes } from '../model-size-estimate.js';

describe('parseModelSizeEstimateBytes', () => {
  it('parses the model registry size formats into binary byte estimates', () => {
    expect(parseModelSizeEstimateBytes('~300MB')).toBe(300 * 1024 * 1024);
    expect(parseModelSizeEstimateBytes('1.5 GB')).toBe(1.5 * 1024 * 1024 * 1024);
    expect(parseModelSizeEstimateBytes('~1.2GB')).toBe(Math.round(1.2 * 1024 ** 3));
    expect(parseModelSizeEstimateBytes('~22.7MB')).toBe(Math.round(22.7 * 1024 ** 2));
    expect(parseModelSizeEstimateBytes('512KB')).toBe(512 * 1024);
  });

  it('reports explicitly unavailable model sizes without inventing an estimate', () => {
    expect(parseModelSizeEstimateBytes(undefined)).toBeNull();
    expect(parseModelSizeEstimateBytes('unknown')).toBeNull();
  });

  it('rejects malformed model size metadata', () => {
    expect(() => parseModelSizeEstimateBytes('roughly large')).toThrow(
      'Unsupported embedding model size metadata'
    );
    expect(() => parseModelSizeEstimateBytes('0MB')).toThrow(
      'Embedding model size estimate must be positive'
    );
  });
});
