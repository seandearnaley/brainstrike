import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INCLUDE_FILTERS,
  DEFAULT_EXCLUDE_FILTERS,
  DEFAULT_USE_REGEX,
  DEFAULT_INCLUDE_PROJECT_TREE,
  DEFAULT_MAX_SELECTION_COUNT,
  DEFAULT_FOLDER_SUMMARY_THRESHOLD,
  MIN_MAX_SELECTION_COUNT,
  MAX_SELECTION_COUNT,
  MIN_FOLDER_SUMMARY_THRESHOLD,
  MAX_FOLDER_SUMMARY_THRESHOLD,
} from '../file-explorer';

describe('FileExplorer types & constants', () => {
  it('should export the correct default include filters', () => {
    expect(DEFAULT_INCLUDE_FILTERS).toEqual(['*.tsx', '*.ts', '*.js', '*.jsx', '*.json']);
  });

  it('should export the correct default exclude filters', () => {
    expect(DEFAULT_EXCLUDE_FILTERS).toEqual(['node_modules', 'test-results', 'playwright-report']);
  });

  it('should export correct default flags', () => {
    expect(DEFAULT_USE_REGEX).toBe(false);
    expect(DEFAULT_INCLUDE_PROJECT_TREE).toBe(true);
  });

  it('should export correct default numeric values', () => {
    expect(DEFAULT_MAX_SELECTION_COUNT).toBe(10);
    expect(DEFAULT_FOLDER_SUMMARY_THRESHOLD).toBe(100);
  });

  it('should export correct range limits', () => {
    expect(MIN_MAX_SELECTION_COUNT).toBe(1);
    expect(MAX_SELECTION_COUNT).toBe(1000);
    expect(MIN_FOLDER_SUMMARY_THRESHOLD).toBe(0);
    expect(MAX_FOLDER_SUMMARY_THRESHOLD).toBe(1000);
  });
}); 