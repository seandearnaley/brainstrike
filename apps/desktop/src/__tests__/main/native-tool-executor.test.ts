import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('native-tool-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isExecutableNativeTool', () => {
    it('returns true for web.searchDocs', async () => {
      const { isExecutableNativeTool } = await import('../../native-tool-executor');
      expect(isExecutableNativeTool('web.searchDocs')).toBe(true);
    });

    it('returns true for web.docSummary', async () => {
      const { isExecutableNativeTool } = await import('../../native-tool-executor');
      expect(isExecutableNativeTool('web.docSummary')).toBe(true);
    });

    it('returns false for unknown tools', async () => {
      const { isExecutableNativeTool } = await import('../../native-tool-executor');
      expect(isExecutableNativeTool('unknown.tool')).toBe(false);
    });

    it('returns false for database-dependent tools', async () => {
      const { isExecutableNativeTool } = await import('../../native-tool-executor');
      expect(isExecutableNativeTool('brainstrike.retrieveContext')).toBe(false);
    });
  });

  describe('executeNativeTool', () => {
    it('executes web.searchDocs successfully', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.searchDocs', {
        query: 'assistant',
        limit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('executes web.docSummary successfully', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.docSummary', {
        docId: 'assistant-ui-integration',
      });

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
    });

    it('returns error for unknown tool', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('unknown.tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('returns error for invalid input', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.searchDocs', {
        query: '', // Invalid: too short
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('trims search queries before execution', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.searchDocs', {
        query: '  assistant  ',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect((result.result as { query: string }).query).toBe('assistant');
    });

    it('defaults the search limit when omitted', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.searchDocs', {
        query: 'assistant',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }
      expect((result.result as { limit: number }).limit).toBe(5);
    });

    it('rejects null bytes in search queries', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.searchDocs', {
        query: 'assist\0ant',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('null bytes');
    });

    it('returns error for doc not found', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('web.docSummary', {
        docId: 'non-existent-doc',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
