import { describe, expect, it } from 'vitest';
import { formatContextWindow, formatTokenCount } from '../utils/format-context-window';

describe('formatTokenCount', () => {
  it.each([
    [512, '512'],
    [999, '999'],
    [1000, '1K'],
    [64_000, '64K'],
    [128_000, '128K'],
    [131_072, '131K'],
    [200_000, '200K'],
    [1_000_000, '1M'],
    [1_050_000, '1.1M'],
    [2_000_000, '2M'],
  ])('%i → %s', (tokens, expected) => {
    expect(formatTokenCount(tokens)).toBe(expected);
  });
});

describe('formatContextWindow', () => {
  it('is formatTokenCount plus the "context" suffix', () => {
    expect(formatContextWindow(1_050_000)).toBe('1.1M context');
    expect(formatContextWindow(200_000)).toBe('200K context');
    expect(formatContextWindow(512)).toBe('512 context');
  });
});
