import { describe, expect, it } from 'vitest';
import { BUILD_DATE, VERSION } from '../version';

describe('version', () => {
  it('should export VERSION as a string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should export BUILD_DATE as a string', () => {
    expect(typeof BUILD_DATE).toBe('string');
    expect(BUILD_DATE).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
