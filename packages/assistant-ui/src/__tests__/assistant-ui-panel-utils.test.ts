// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  clampNumber,
  clampProgress,
  getLocalModelStatusLabel,
  parseNumber,
  truncateMiddle,
} from '../assistant-ui-panel-utils';

describe('assistant-ui-panel utils', () => {
  it('maps local model stages to user-facing labels', () => {
    expect(getLocalModelStatusLabel('downloading')).toBe('Downloading');
    expect(getLocalModelStatusLabel('loading')).toBe('Starting');
    expect(getLocalModelStatusLabel('generating')).toBe('Working');
    expect(getLocalModelStatusLabel('ready')).toBe('Ready');
    expect(getLocalModelStatusLabel('error')).toBe('Unavailable');
  });

  it('clamps progress values to a safe range', () => {
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(-10)).toBe(0);
    expect(clampProgress(42)).toBe(42);
    expect(clampProgress(120)).toBe(100);
  });

  it('truncates long middle values and preserves short ones', () => {
    expect(truncateMiddle('short-value', 4, 4)).toBe('short-value');
    expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 5, 4)).toBe('abcde…wxyz');
  });

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
