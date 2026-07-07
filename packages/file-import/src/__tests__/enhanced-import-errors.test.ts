import type { FileImportResult } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { runEnhancedImport } from '../enhanced-import';

describe('runEnhancedImport error handling', () => {
  const mockChunking = {
    deps: { chunkRepository: null, repository: null },
    enabled: false,
  };

  const mockProgressHandlers = {
    emit: vi.fn(),
    update: vi.fn(),
  };

  it('handles catastrophic failure in baseImportRunner', async () => {
    const error = new Error('Catastrophic failure');
    const baseImportRunner = vi.fn().mockRejectedValue(error);

    await expect(
      runEnhancedImport({
        baseImportRunner,
        chunking: mockChunking,
        progressHandlers: mockProgressHandlers,
        request: {
          fileContents: {},
          fileTree: [],
          selectedFilePaths: new Set(),
        },
      })
    ).rejects.toThrow('Catastrophic failure');
  });

  it('handles default progress creation when no progress reported', async () => {
    const baseImportRunner = vi
      .fn()
      .mockResolvedValue([{ existed: false, id: 'file-1', imported: true } as FileImportResult]);

    // chunking disabled to trigger createCompleteProgress with null source
    await runEnhancedImport({
      baseImportRunner,
      chunking: { ...mockChunking, enabled: false }, // Ensure disabled to hit that block
      progressHandlers: mockProgressHandlers,
      request: {
        fileContents: {},
        fileTree: [],
        selectedFilePaths: new Set(),
      },
    });

    // Verify the update call with the default complete progress
    const calls = mockProgressHandlers.update.mock.calls;
    // There should be a call where prev is null, and it returns the default complete progress
    // But runEnhancedImport logic:
    // 1. baseImportRunner finishes. latestProgress is null (since onProgress not called).
    // 2. if (!chunking.enabled) -> createCompleteProgress(null, results.length)

    // We need to verify that createCompleteProgress was called with null and generated the default object
    const updateFn = calls.at(-1)?.[0];
    if (!updateFn) {
      throw new Error('updateFn is undefined');
    }

    const result = updateFn(null); // Simulate prev=null

    expect(result.phase).toBe('complete');
    expect(result.completed).toBe(1); // total results
    expect(result.current).toBe('');
  });
});
