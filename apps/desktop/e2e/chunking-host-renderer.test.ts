import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface ChunkingHostStatus {
  active: boolean;
  lastError: string | null;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface SentenceChunkFileRequest {
  content: string;
  fileName: string;
  filePath: string;
  fileRecordId: string;
  kind: 'chunk-file';
  options: {
    forceStrategy: boolean;
    strategy: 'sentence';
  };
  requestId: string;
}

async function chunkSentenceFile(
  page: Page,
  request: SentenceChunkFileRequest
): Promise<{
  chunks: unknown[];
  skipped?: boolean;
  skipReason?: string;
}> {
  return await page.evaluate((chunkRequest) => {
    const api = (
      globalThis.window as Window & {
        chunkingHost?: {
          chunkFile?: (request: SentenceChunkFileRequest) => Promise<{
            chunks: unknown[];
            skipped?: boolean;
            skipReason?: string;
          }>;
        };
      }
    ).chunkingHost;
    if (!api?.chunkFile) {
      throw new Error('Chunking host bridge is not available');
    }
    return api.chunkFile(chunkRequest);
  }, request);
}

async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

async function assertVisibleWindowResponsive(page: Page): Promise<void> {
  const assistantShell = page.getByTestId('assistant-chat-card');
  const workspaceToggle = page
    .getByTestId('show-workspace-panel')
    .or(page.getByTestId('hide-workspace-panel'));

  await expect(assistantShell).toBeVisible({ timeout: 10_000 });

  const domState = await page.evaluate(() => ({
    hasRoot: Boolean(document.getElementById('root')),
    readyState: document.readyState,
  }));
  expect(domState).toEqual({
    hasRoot: true,
    readyState: 'complete',
  });

  await expect(workspaceToggle.first()).toBeVisible({ timeout: 10_000 });
}

async function getChunkingHostStatus(page: Page): Promise<ChunkingHostStatus> {
  return await page.evaluate<ChunkingHostStatus>(async () => {
    const api = (
      window as Window & {
        chunkingHost?: {
          getStatus?: () => Promise<ChunkingHostStatus>;
        };
      }
    ).chunkingHost;
    if (!api?.getStatus) {
      throw new Error('Chunking host bridge is not available');
    }
    return await api.getStatus();
  });
}

async function getMainBufferedLogs(page: Page): Promise<
  Array<{
    bindings?: Record<string, unknown>;
    message?: string;
    scope?: string;
  }>
> {
  return await page.evaluate(async () => {
    const loggingApi = (
      window as Window & {
        logging?: {
          getBufferedLogs?: () => Promise<
            Array<{
              bindings?: Record<string, unknown>;
              message?: string;
              scope?: string;
            }>
          >;
        };
      }
    ).logging;
    if (!loggingApi?.getBufferedLogs) {
      throw new Error('Logging bridge is not available');
    }
    return await loggingApi.getBufferedLogs();
  });
}

test.describe('Chunking Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  test('hidden chunking host can die without reloading the visible window', async ({
    electronApp,
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('running');

    await electronApp.app.evaluate(async ({ BrowserWindow }) => {
      const hostWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('mode=chunking-host')
      );
      if (!hostWindow) {
        throw new Error('Chunking host window was not found');
      }
      hostWindow.destroy();
    });

    await expect
      .poll(async () => {
        const status = await getChunkingHostStatus(window);
        return status.state;
      })
      .toBe('stopped');

    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('hidden chunking host logs are forwarded into the exported desktop log stream', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);

    await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            ensureStarted?: () => Promise<ChunkingHostStatus>;
          };
        }
      ).chunkingHost;
      if (!api?.ensureStarted) {
        throw new Error('Chunking host bridge is not available');
      }
      await api.ensureStarted();
    });

    await expect
      .poll(async () => {
        const logs = await getMainBufferedLogs(window);
        return logs.some(
          (record) =>
            record.message === 'Background renderer log forwarding enabled' &&
            record.bindings?.['sourceWindowRole'] === 'chunking-host'
        );
      })
      .toBe(true);
  });

  test('large chunking requests do not reload the visible window', async ({ window }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'sentence';
              };
              requestId: string;
            }) => Promise<{
              chunks: unknown[];
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      const largeContent = Array.from(
        { length: 8192 },
        (_, index) => `Sentence ${index + 1} ends here.`
      ).join(' ');
      try {
        const result = await api.chunkFile({
          kind: 'chunk-file',
          requestId: crypto.randomUUID(),
          fileRecordId: 'chunking-host-large-request',
          fileName: 'large-import.txt',
          filePath: '/tmp/large-import.txt',
          content: largeContent,
          options: {
            strategy: 'sentence',
            forceStrategy: true,
          },
        });
        return { ok: true as const, chunkCount: result.chunks.length };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    expect(requestOutcome.ok).toBe(true);
    if (requestOutcome.ok) {
      expect(requestOutcome.chunkCount).toBeGreaterThan(0);
    }
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('oversized chunking requests skip at file level without poisoning the hidden chunking host', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const oversizedContent = 'x'.repeat(600 * 1024);
    const oversizedOutcome = await chunkSentenceFile(window, {
      kind: 'chunk-file',
      requestId: crypto.randomUUID(),
      fileRecordId: 'chunking-host-oversized-request',
      fileName: 'oversized-import.txt',
      filePath: '/tmp/oversized-import.txt',
      content: oversizedContent,
      options: {
        strategy: 'sentence',
        forceStrategy: true,
      },
    }).then(
      (result) => ({
        ok: true as const,
        skipped: result.skipped ?? false,
        skipReason: result.skipReason ?? null,
      }),
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      })
    );

    expect(oversizedOutcome.ok).toBe(true);
    if (oversizedOutcome.ok) {
      expect(oversizedOutcome.skipped).toBe(true);
      expect(oversizedOutcome.skipReason).toContain('File too large');
    }

    const followupOutcome = await chunkSentenceFile(window, {
      kind: 'chunk-file',
      requestId: crypto.randomUUID(),
      fileRecordId: 'chunking-host-followup-request',
      fileName: 'followup.txt',
      filePath: '/tmp/followup.txt',
      content: Array.from(
        { length: 128 },
        (_, index) => `Follow-up line ${index + 1} after oversized request.`
      ).join('\n'),
      options: {
        strategy: 'sentence',
        forceStrategy: true,
      },
    }).then((result) => result.chunks.length);

    expect(followupOutcome).toBeGreaterThan(0);
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('accepts non-legacy chunking strategies without reloading the visible window', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'character';
              };
              requestId: string;
            }) => Promise<{
              chunks: Array<{ content: string }>;
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      const result = await api.chunkFile({
        kind: 'chunk-file',
        requestId: crypto.randomUUID(),
        fileRecordId: 'chunking-host-character-request',
        fileName: 'structured-notes.txt',
        filePath: '/tmp/structured-notes.txt',
        content: Array.from(
          { length: 256 },
          (_, index) => `Line ${index + 1}: deterministic chunking host test content.`
        ).join('\n'),
        options: {
          strategy: 'character',
          forceStrategy: true,
        },
      });

      return result.chunks.length;
    });

    expect(requestOutcome).toBeGreaterThan(0);
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });

  test('supports accurate token sizing in the hidden chunking host without crashing the visible window', async ({
    window,
  }) => {
    await waitForAppReadyInTest(window);
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);

    const requestOutcome = await window.evaluate(async () => {
      const api = (
        globalThis.window as Window & {
          chunkingHost?: {
            chunkFile?: (request: {
              fileRecordId: string;
              content: string;
              fileName: string;
              filePath: string;
              kind: 'chunk-file';
              options: {
                forceStrategy: boolean;
                strategy: 'sentence';
                tokenTrueSizing: true;
              };
              requestId: string;
            }) => Promise<{
              chunks: Array<{ tokenCount: number }>;
              totalTokens: number;
            }>;
          };
        }
      ).chunkingHost;
      if (!api?.chunkFile) {
        throw new Error('Chunking host bridge is not available');
      }

      try {
        const result = await api.chunkFile({
          kind: 'chunk-file',
          requestId: crypto.randomUUID(),
          fileRecordId: 'chunking-host-accurate-token-request',
          fileName: 'accurate-token-host.txt',
          filePath: '/tmp/accurate-token-host.txt',
          content: Array.from(
            { length: 128 },
            (_, index) => `Deterministic accurate token sizing line ${index + 1}.`
          ).join('\n'),
          options: {
            strategy: 'sentence',
            forceStrategy: true,
            tokenTrueSizing: true,
          },
        });
        return {
          ok: true as const,
          chunkCount: result.chunks.length,
          totalTokens: result.totalTokens,
          minTokenCount:
            result.chunks.length > 0
              ? Math.min(...result.chunks.map((chunk) => chunk.tokenCount))
              : 0,
        };
      } catch (error) {
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    expect(requestOutcome.ok).toBe(true);
    if (requestOutcome.ok) {
      expect(requestOutcome.chunkCount).toBeGreaterThan(0);
      expect(requestOutcome.totalTokens).toBeGreaterThan(0);
      expect(requestOutcome.minTokenCount).toBeGreaterThan(0);
    }
    await assertVisibleWindowResponsive(window);
    const finalTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    expect(finalTimeOrigin).toBe(initialTimeOrigin);
  });
});
