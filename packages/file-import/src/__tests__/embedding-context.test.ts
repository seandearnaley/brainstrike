import { describe, expect, it, vi } from 'vitest';
import { buildEmbeddingText, detectLanguage, extractHeadingPath } from '../embedding-context';

describe('embedding-context helpers', () => {
  it('prepends contextual metadata in stable order', () => {
    const result = buildEmbeddingText('export const value = 1;', {
      filePath: 'src/utils/value.ts',
      headingPath: 'API > Values',
      language: 'typescript',
    });

    expect(result).toContain('File: src/utils/value.ts');
    expect(result).toContain('Section: API > Values');
    expect(result).toContain('Language: typescript');
    expect(result.endsWith('export const value = 1;')).toBe(true);
  });

  it('returns original content when context is empty', () => {
    expect(buildEmbeddingText('plain text', {})).toBe('plain text');
  });

  it('extracts the most recent nested markdown heading path', () => {
    const markdown = [
      '# Getting Started',
      'intro',
      '## Installation',
      'details',
      '### Linux',
      'commands',
      '## Usage',
      'text',
      '### CLI',
    ].join('\n');

    expect(extractHeadingPath(markdown)).toBe('Getting Started > Usage > CLI');
    expect(extractHeadingPath('No headings here')).toBeUndefined();
  });

  it('detects known languages and returns undefined for unknown extensions', () => {
    expect(detectLanguage('src/main.ts')).toBe('typescript');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('script.sh')).toBe('shell');
    expect(detectLanguage('archive.unknown')).toBeUndefined();
    expect(detectLanguage('no-extension')).toBeUndefined();
  });

  it('detects language from the final extension without splitting the full path', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(detectLanguage('packages/app-shell/src/background-indexing/worker.TSX')).toBe(
        'typescript'
      );
      expect(detectLanguage('docs/no-extension')).toBeUndefined();
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });
});
