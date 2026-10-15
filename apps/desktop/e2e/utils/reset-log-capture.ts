import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';

/** Keep errors from both retired and replacement processes (BST-1992). */
export function captureResetLogs(): {
  attach: (testInfo: TestInfo) => Promise<void>;
  assertClean: () => void;
  observeApp: (app: ElectronApplication) => void;
  join: () => Promise<void>;
} {
  const streams: string[][] = [];
  const closed: Promise<void>[] = [];
  const rendererErrors: string[] = [];
  const observedPages = new WeakSet<Page>();
  const observePage = (page: Page): void => {
    if (observedPages.has(page)) {
      return;
    }
    observedPages.add(page);
    page.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        rendererErrors.push(message.text());
      }
    });
  };
  const processLogs = (): string[] => streams.map((chunks) => chunks.join(''));
  return {
    assertClean: () => {
      expect.soft(rendererErrors, 'Renderer errors across reset and full reopen').toEqual([]);
      for (const log of processLogs()) {
        expect.soft(log).not.toContain('Error occurred in handler');
        // Pino levels 50/60 are error/fatal. Retain every scope, including shutdown.
        expect.soft(log).not.toMatch(/"level"\s*:\s*(?:50|60)\b/);
      }
    },
    attach: async (testInfo) => {
      await testInfo.attach('factory-reset-process-and-renderer-logs', {
        body: JSON.stringify({ processLogs: processLogs(), rendererErrors }, null, 2),
        contentType: 'application/json',
      });
    },
    join: async () => {
      await Promise.all(closed);
    },
    observeApp: (app) => {
      closed.push(new Promise<void>((resolve) => app.process().once('close', () => resolve())));
      for (const stream of [app.process().stdout, app.process().stderr]) {
        const chunks: string[] = [];
        streams.push(chunks);
        stream?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
      }
      app.on('window', observePage);
      for (const page of app.windows()) {
        observePage(page);
      }
    },
  };
}
