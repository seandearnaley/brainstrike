import { describe, expect, it, vi } from 'vitest';
import { collectDesktopPlatformDiagnostics } from '../desktop-platform-diagnostics';

describe('desktop platform diagnostics', () => {
  it('collects one typed snapshot across database, scheduler, hosts, logging, and reset state', async () => {
    const databaseDiagnostics = { hasDatabaseHandle: true };
    const schedulerSnapshot = { activeCount: 0 };
    const embeddingHostStatus = {
      active: false,
      lastError: null,
      pendingRequestCount: 0,
      runtimeId: 'embedding-host:stopped',
      runtimeKind: 'embedding-host' as const,
      sourceState: 'stopped' as const,
      state: 'stopped' as const,
    };
    const llmHostStatus = {
      active: true,
      lastError: null,
      pendingRequestCount: 1,
      runtimeId: 'llm-host:running',
      runtimeKind: 'llm-host' as const,
      sourceState: 'running' as const,
      state: 'active' as const,
    };
    const loggingState = {
      capabilities: { fileDestination: true },
      preferences: {
        console: true,
        file: { enabled: false, path: null },
        level: 'info',
        redactPaths: [],
      },
    };

    const snapshot = await collectDesktopPlatformDiagnostics({
      database: { getDiagnostics: vi.fn(async () => databaseDiagnostics) },
      databaseScheduler: { getSnapshot: vi.fn(() => schedulerSnapshot) },
      embeddingHost: { getPlatformStatus: vi.fn(() => embeddingHostStatus) },
      llmHost: { getPlatformStatus: vi.fn(() => llmHostStatus) },
      logging: { getState: vi.fn(() => loggingState) },
      reset: { getUserDataPath: vi.fn(() => '/tmp/brainstrike-user-data') },
    });

    expect(snapshot).toMatchObject({
      database: databaseDiagnostics,
      databaseScheduler: schedulerSnapshot,
      embeddingHost: embeddingHostStatus,
      llmHost: llmHostStatus,
      logging: loggingState,
      reset: { userDataPath: '/tmp/brainstrike-user-data' },
    });
    expect(Date.parse(snapshot.collectedAt)).not.toBeNaN();
  });
});
