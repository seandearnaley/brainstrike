// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clampNumber, parseNumber } from '../assistant-ui-panel-utils';

describe('assistant-ui-panel utils', () => {
  it('clamps numeric settings values', () => {
    expect(clampNumber(Number.NaN, 10, 20)).toBe(10);
    expect(clampNumber(5, 10, 20)).toBe(10);
    expect(clampNumber(15, 10, 20)).toBe(15);
    expect(clampNumber(25, 10, 20)).toBe(20);
  });

  it('parses finite numeric input and rejects blanks', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('   ')).toBeUndefined();
    expect(parseNumber('18')).toBe(18);
    expect(parseNumber('18.5')).toBe(18.5);
    expect(parseNumber('Infinity')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
  });
});
