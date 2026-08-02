import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE,
  formatFileSize,
  getFileSizeConfig,
  resetFileSizeConfig,
  setFileSizeConfig,
} from '../config.js';

describe('file size config', () => {
  beforeEach(() => {
    resetFileSizeConfig();
  });

  it('returns defaults and does not expose mutable internal state', () => {
    const first = getFileSizeConfig();
    expect(first.maxFileSize).toBe(DEFAULT_MAX_FILE_SIZE);

    first.maxFileSize = 1;

    const second = getFileSizeConfig();
    expect(second.maxFileSize).toBe(DEFAULT_MAX_FILE_SIZE);
  });

  it('updates and resets max file size configuration', () => {
    setFileSizeConfig({ maxFileSize: 1024 });
    expect(getFileSizeConfig()).toEqual({ maxFileSize: 1024 });

    resetFileSizeConfig();
    expect(getFileSizeConfig()).toEqual({ maxFileSize: DEFAULT_MAX_FILE_SIZE });
  });
});

describe('formatFileSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatFileSize(512)).toBe('512B');
    expect(formatFileSize(2048)).toBe('2KB');
    expect(formatFileSize(2_621_440)).toBe('2.5MB');
  });
});
