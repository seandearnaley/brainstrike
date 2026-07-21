import type { FileImportResult } from '@brainstrike/db';
import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  setLogLevel,
} from '@brainstrike/utils/logger';
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

  it('reports cancellation without misclassifying it as a catastrophic failure', async () => {
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileImport:Enhanced') {
        captured.push(record);
      }
    });
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(
        runEnhancedImport({
          abortSignal: controller.signal,
          baseImportRunner: vi.fn(),
          chunking: mockChunking,
          progressHandlers: mockProgressHandlers,
          request: {
            fileContents: {},
            fileTree: [],
            selectedFilePaths: new Set(),
          },
        })
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(captured).toContainEqual(
        expect.objectContaining({ level: 'info', message: 'Enhanced import cancelled' })
      );
      expect(captured).not.toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'Enhanced import failed catastrophically:',
        })
      );
    } finally {
      removeListener();
      configureLogger({ enableInProduction: false });
    }
  });

  it('reports a genuine failure even when the runner aborts its signal first', async () => {
    configureLogger({ enableInProduction: true });
    setLogLevel(LogLevel.INFO);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'FileImport:Enhanced') {
        captured.push(record);
      }
    });
    const controller = new AbortController();
    const failure = new Error('Import teardown failed');

    try {
      await expect(
        runEnhancedImport({
          abortSignal: controller.signal,
          baseImportRunner: vi.fn(async () => {
            controller.abort();
            throw failure;
          }),
          chunking: mockChunking,
          progressHandlers: mockProgressHandlers,
          request: {
            fileContents: {},
            fileTree: [],
            selectedFilePaths: new Set(),
          },
        })
      ).rejects.toBe(failure);

      expect(captured).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'Enhanced import failed catastrophically:',
        })
      );
      expect(captured).not.toContainEqual(
        expect.objectContaining({ level: 'info', message: 'Enhanced import cancelled' })
      );
    } finally {
      removeListener();
      configureLogger({ enableInProduction: false });
    }
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
