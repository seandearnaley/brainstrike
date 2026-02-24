import { describe, expect, it } from 'vitest';
import { normalizeFilePathForFolder, validateRelativeFilePath } from '../relative-file-path';

describe('validateRelativeFilePath', () => {
  it('accepts safe relative paths', () => {
    expect(validateRelativeFilePath('src/components/button.tsx')).toBe('src/components/button.tsx');
  });

  it('rejects absolute paths', () => {
    expect(() => validateRelativeFilePath('/absolute/path.ts')).toThrow(
      'File path must be relative'
    );
    expect(() => validateRelativeFilePath('C:\\absolute\\path.ts')).toThrow(
      'File path must be relative'
    );
  });
});

describe('normalizeFilePathForFolder', () => {
  it('keeps relative paths unchanged', () => {
    expect(normalizeFilePathForFolder('src/index.ts', 'project')).toBe('src/index.ts');
  });

  it('converts unix absolute paths using folder id segment', () => {
    const absolutePath = '/Users/me/workspace/project/src/index.ts';
    expect(normalizeFilePathForFolder(absolutePath, 'project')).toBe('src/index.ts');
  });

  it('converts windows absolute paths using folder id segment', () => {
    const absolutePath = 'C:\\Users\\me\\workspace\\Project\\src\\index.ts';
    expect(normalizeFilePathForFolder(absolutePath, 'project')).toBe('src/index.ts');
  });

  it('strips leading slash when folder id is not present', () => {
    expect(normalizeFilePathForFolder('/src/index.ts', 'project')).toBe('src/index.ts');
  });
});
