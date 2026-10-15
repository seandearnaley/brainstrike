// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { TableRowData } from '../../utils/grouping-configs';
import { buildTapestryFileBase } from '../tapestry-adapter';

const baseItem: TableRowData = {
  compositeKey: 'folder-a|@|src/file-a.ts',
  id: 'file-a',
  path: 'src/file-a.ts',
  rootFolderId: 'folder-a',
  type: 'ts',
};

describe('buildTapestryFileBase', () => {
  it('uses size-based line estimation over token-based estimation for unloaded files', () => {
    const item: TableRowData = {
      ...baseItem,
      size: 8000, // 100 estimated lines @ 80 bytes/line
      tokens: 2400, // 200 estimated lines @ 12 tokens/line
    };

    const file = buildTapestryFileBase({
      content: undefined,
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(100);
    expect(file.structure).toHaveLength(100);
    expect(file.contentStatus).toBe('idle');
  });

  it('falls back to token estimation when size metadata is unavailable', () => {
    const item: TableRowData = {
      ...baseItem,
      tokens: 2400,
    };

    const file = buildTapestryFileBase({
      content: undefined,
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(200);
    expect(file.structure).toHaveLength(200);
  });

  it('uses real content lines when content is loaded', () => {
    const item: TableRowData = {
      ...baseItem,
      size: 80_000,
      tokens: 24_000,
    };

    const file = buildTapestryFileBase({
      content: 'line 1\nline 2\nline 3',
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(3);
    expect(file.contentStatus).toBe('ready');
    expect(file.content).toEqual(['line 1', 'line 2', 'line 3']);
  });

  // Token counts resolve asynchronously on a ~100ms cadence for EVERY selected
  // file; each tick rebuilds bases with fresh metadata. The expensive
  // content-derived parts (split lines + per-line structure) depend only on
  // the content string — reusing them keeps a token tick O(metadata) per file
  // instead of O(total characters), and preserves structure identity so the
  // minimap's SVG memo stays warm.
  describe('previous-base reuse', () => {
    it('reuses content lines and structure identity when content is unchanged (tokens resolved)', () => {
      const content = 'const a = 1;\nfunction b() {}\n  return 2;\n';
      const first = buildTapestryFileBase({
        content,
        isLoading: false,
        item: { ...baseItem, size: 80 },
      });
      const second = buildTapestryFileBase({
        content,
        isLoading: false,
        item: { ...baseItem, size: 80, tokens: 12 },
        previous: { base: first, content },
      });

      expect(second.tokens).toBe(12);
      expect(second.content).toBe(first.content);
      expect(second.structure).toBe(first.structure);
      // Value-equivalent to a from-scratch build.
      expect(second).toEqual(
        buildTapestryFileBase({
          content,
          isLoading: false,
          item: { ...baseItem, size: 80, tokens: 12 },
        })
      );
    });

    it('reuses the estimated structure when the line estimate is unchanged', () => {
      const first = buildTapestryFileBase({
        content: undefined,
        isLoading: false,
        item: { ...baseItem, size: 8000 },
      });
      const second = buildTapestryFileBase({
        content: undefined,
        isLoading: true,
        item: { ...baseItem, size: 8000 },
        previous: { base: first, content: undefined },
      });

      expect(second.contentStatus).toBe('loading');
      expect(second.structure).toBe(first.structure);
    });

    it('rebuilds when content changed', () => {
      const first = buildTapestryFileBase({
        content: 'a\nb\n',
        isLoading: false,
        item: baseItem,
      });
      const second = buildTapestryFileBase({
        content: 'a\nb\nc\n',
        isLoading: false,
        item: baseItem,
        previous: { base: first, content: 'a\nb\n' },
      });

      expect(second.totalLines).toBe(4);
      expect(second.structure).not.toBe(first.structure);
    });

    it('rebuilds the estimated structure when the estimate inputs changed it', () => {
      const first = buildTapestryFileBase({
        content: undefined,
        isLoading: false,
        item: { ...baseItem, size: 8000 },
      });
      const second = buildTapestryFileBase({
        content: undefined,
        isLoading: false,
        item: { ...baseItem, size: 16_000 },
        previous: { base: first, content: undefined },
      });

      expect(second.totalLines).toBe(200);
      expect(second.structure).not.toBe(first.structure);
      expect(second.structure).toHaveLength(200);
    });
  });
});
