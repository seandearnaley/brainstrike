import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { Page } from '@playwright/test';

/** One record of Main's session log buffer, as Settings → Logs reads it. */
export interface MainBufferedLogRecord {
  args?: readonly unknown[];
  bindings?: Record<string, unknown>;
  level?: string;
  message?: string;
  scope?: string;
}

/** Main's buffered session log records, read through the renderer's logging bridge. */
export async function getMainBufferedLogs(page: Page): Promise<MainBufferedLogRecord[]> {
  return await page.evaluate<MainBufferedLogRecord[]>(async () => {
    const loggingApi = (
      window as Window & {
        logging?: {
          getBufferedLogs?: () => Promise<BoundaryResult<MainBufferedLogRecord[]>>;
        };
      }
    ).logging;
    if (!loggingApi?.getBufferedLogs) {
      throw new Error('Logging bridge is not available');
    }
    const response = await loggingApi.getBufferedLogs();
    if (!response.ok) {
      throw new Error(JSON.stringify(response.error));
    }
    return response.value;
  });
}
