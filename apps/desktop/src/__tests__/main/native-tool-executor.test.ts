import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('native-tool-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isExecutableNativeTool', () => {
    it('returns false for all tools when native playground executor is empty', async () => {
      const { isExecutableNativeTool } = await import('../../native-tool-executor');
      expect(isExecutableNativeTool('brainstrike.readWorkspaceFile')).toBe(false);
      expect(isExecutableNativeTool('web.searchDocs')).toBe(false);
      expect(isExecutableNativeTool('unknown.tool')).toBe(false);
    });
  });

  describe('executeNativeTool', () => {
    it('returns unsupported error for any tool', async () => {
      const { executeNativeTool } = await import('../../native-tool-executor');
      const result = await executeNativeTool('brainstrike.readWorkspaceFile', {
        path: '/README.md',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
