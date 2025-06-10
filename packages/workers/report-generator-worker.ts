import type { DirectoryHandle } from '@brainstrike/file-system';
import { Worker } from 'node:worker_threads';

export interface ReportGeneratorRequest {
  rootHandle: DirectoryHandle;
  selectedFiles: string[];
  fileContents: Record<string, string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;
}

export interface ReportWorkerConfig {
  adapterType: 'mock';
  adapterData?: unknown;
}

export interface ProgressEvent {
  path: string;
}

export function createReportGeneratorWorker(config: ReportWorkerConfig) {
  return async function generate(
    req: ReportGeneratorRequest,
    onProgress?: (e: ProgressEvent) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../dist/report-generator-thread.js', import.meta.url), {
        workerData: { config, req },
      });
      worker.on('message', (msg: { type: string; data: any }) => {
        if (msg.type === 'progress') onProgress?.(msg.data);
        if (msg.type === 'result') resolve(msg.data);
      });
      worker.on('error', reject);
      worker.on('exit', (code: number) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });
  };
}
