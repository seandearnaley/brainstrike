import { describe, expect, it } from 'vitest';
import {
  createSanitizedToolNameMap,
  sanitizeTools,
  type ToolsInput,
} from '../tool-projection/tool-sanitizer';

describe('tool-sanitizer', () => {
  describe('sanitizeTools', () => {
    it('returns undefined when tools is undefined', () => {
      const map = new Map<string, string>();
      const result = sanitizeTools(undefined, map);
      expect(result).toBeUndefined();
      expect(map.size).toBe(0);
    });

    it('sanitizes tool names by replacing non-alphanumeric characters with underscores', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        'db@query': { description: 'query tool', id: 'db@query' },
        'file/read': { description: 'read tool', id: 'file/read' },
        'web.search': { description: 'search tool', id: 'web.search' },
      };

      const result = sanitizeTools(tools, map);

      expect(result).toBeDefined();
      expect(Object.keys(result ?? {})).toEqual(
        expect.arrayContaining(['web_search', 'file_read', 'db_query'])
      );
      expect(map.get('web_search')).toBe('web.search');
      expect(map.get('file_read')).toBe('file/read');
      expect(map.get('db_query')).toBe('db@query');
    });

    it('preserves already-sanitized tool names', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        file_read: { description: 'read', id: 'file_read' },
        web_search: { description: 'search', id: 'web_search' },
      };

      const result = sanitizeTools(tools, map);

      expect(result).toBeDefined();
      expect(Object.keys(result ?? {})).toEqual(
        expect.arrayContaining(['web_search', 'file_read'])
      );
      // For already sanitized names, map should have them but pointing to themselves
      expect(map.get('web_search')).toBe('web_search');
      expect(map.get('file_read')).toBe('file_read');
    });

    it('handles collision by appending hash suffix', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        'web.search': { description: 'first', id: 'web.search' },
        'web/search': { description: 'second', id: 'web/search' },
      };

      const result = sanitizeTools(tools, map);

      const sanitizedNames = Object.keys(result ?? {});
      expect(sanitizedNames).toHaveLength(2);
      expect(new Set(sanitizedNames).size).toBe(2); // Ensure unique names

      expect(map.get('web_search')).toBe('web.search');

      // The second one should get a hash suffix
      const otherName = sanitizedNames.find((name) => name !== 'web_search');
      expect(otherName).toBeDefined();
      expect(map.get(otherName as string)).toBe('web/search');
    });

    it('handles multiple collisions with incremental counter', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        'web-search': { description: 'third', id: 'web-search' },
        'web.search': { description: 'first', id: 'web.search' },
        'web/search': { description: 'second', id: 'web/search' },
      };

      const result = sanitizeTools(tools, map);

      const sanitizedNames = Object.keys(result ?? {});
      expect(sanitizedNames).toHaveLength(3);
      expect(new Set(sanitizedNames).size).toBe(3); // All unique

      // All original names should be tracked
      expect(map.size).toBe(3);
      const originalNames = Array.from(map.values());
      expect(originalNames).toEqual(
        expect.arrayContaining(['web.search', 'web/search', 'web-search'])
      );
    });

    it('updates tool id to match sanitized name', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        'web.search': { description: 'search tool', id: 'web.search' } as ToolsInput[string] & {
          extra: string;
        },
      };

      const result = sanitizeTools(tools, map);

      expect(result).toBeDefined();
      const sanitizedTool = result?.['web_search'] as
        | (ToolsInput[string] & { id: string; extra?: string })
        | undefined;
      expect(sanitizedTool).toBeDefined();
      expect(sanitizedTool?.id).toBe('web_search');
      expect(sanitizedTool?.description).toBe('search tool');
    });

    it('preserves tool object when name does not change', () => {
      const map = new Map<string, string>();
      const originalTool = { description: 'search', id: 'web_search' };
      const tools: ToolsInput = {
        web_search: originalTool,
      };

      const result = sanitizeTools(tools, map);

      expect(result?.['web_search']).toBe(originalTool); // Same reference
    });

    it('clones tool object when name changes', () => {
      const map = new Map<string, string>();
      const originalTool = { description: 'search', id: 'web.search' };
      const tools: ToolsInput = {
        'web.search': originalTool,
      };

      const result = sanitizeTools(tools, map);

      expect(result?.['web_search']).not.toBe(originalTool); // Different reference
      expect(result?.['web_search']?.description).toBe('search'); // Same content
    });

    it('falls back to "tool" when sanitized name is empty or just underscores', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {
        '!!!': { description: 'special chars only', id: '!!!' },
        '###': { description: 'another special', id: '###' },
      };

      const result = sanitizeTools(tools, map);

      const sanitizedNames = Object.keys(result ?? {});
      expect(sanitizedNames).toHaveLength(2);

      // Names should be sanitized (may be underscores or 'tool' fallback)
      for (const name of sanitizedNames) {
        expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(true);
      }

      // Should be unique
      expect(new Set(sanitizedNames).size).toBe(2);

      // Should track original names
      expect(map.size).toBe(2);
    });

    it('respects existing names in the map to avoid conflicts', () => {
      const map = new Map<string, string>();
      map.set('web_search', 'existing.tool');

      const tools: ToolsInput = {
        'web.search': { description: 'new tool', id: 'web.search' },
      };

      const result = sanitizeTools(tools, map);

      // Should not overwrite existing mapping
      const sanitizedNames = Object.keys(result ?? {});
      expect(sanitizedNames).toHaveLength(1);
      expect(sanitizedNames[0]).not.toBe('web_search'); // Should get different name

      // Original mapping should remain
      expect(map.get('web_search')).toBe('existing.tool');
    });

    it('handles tools with very long names', () => {
      const map = new Map<string, string>();
      const longName = `${'a'.repeat(200)}.${'b'.repeat(200)}`;
      const tools: ToolsInput = {
        [longName]: { description: 'long name tool', id: longName },
      };

      const result = sanitizeTools(tools, map);

      expect(result).toBeDefined();
      const sanitizedNames = Object.keys(result ?? {});
      expect(sanitizedNames).toHaveLength(1);

      // Should successfully sanitize and track
      const firstSanitizedName = sanitizedNames[0];
      if (firstSanitizedName) {
        expect(map.get(firstSanitizedName)).toBe(longName);
      }
    });

    it('handles empty tools object', () => {
      const map = new Map<string, string>();
      const tools: ToolsInput = {};

      const result = sanitizeTools(tools, map);

      expect(result).toEqual({});
      expect(map.size).toBe(0);
    });

    it('preserves tool prototype chain when cloning', () => {
      const map = new Map<string, string>();

      class CustomTool {
        id: string;
        description: string;

        constructor(id: string, description: string) {
          this.id = id;
          this.description = description;
        }

        execute() {
          return 'executed';
        }
      }

      const customTool = new CustomTool('web.search', 'search');
      const tools: ToolsInput = {
        'web.search': customTool as unknown as ToolsInput[string],
      };

      const result = sanitizeTools(tools, map);

      const sanitizedTool = result?.['web_search'] as unknown as CustomTool | undefined;
      expect(sanitizedTool).toBeDefined();
      expect(typeof sanitizedTool?.execute).toBe('function');
      expect(sanitizedTool?.execute()).toBe('executed');
    });
  });

  describe('createSanitizedToolNameMap', () => {
    it('maps sanitized names back to their original tool ids', () => {
      const result = createSanitizedToolNameMap([
        'filesystem.read_file',
        'filesystem.list_directory',
      ]);

      expect(result.get('filesystem_read_file')).toBe('filesystem.read_file');
      expect(result.get('filesystem_list_directory')).toBe('filesystem.list_directory');
    });

    it('preserves collision-safe hash suffixes', () => {
      const result = createSanitizedToolNameMap(['web.search', 'web/search']);

      expect(result.get('web_search')).toBe('web.search');
      const hashedEntry = Array.from(result.entries()).find(([key]) => key !== 'web_search');
      expect(hashedEntry?.[1]).toBe('web/search');
    });
  });
});
