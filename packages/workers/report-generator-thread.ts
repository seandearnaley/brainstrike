import { parentPort, workerData } from 'node:worker_threads';
import { generateReportFromAdapter } from '@brainstrike/utils';
import { MockFileSystemAdapter } from '@brainstrike/file-system';

const { config, req } = workerData as {
  config: { adapterType: 'mock'; adapterData?: unknown };
  req: any;
};

let adapter: MockFileSystemAdapter;
if (config.adapterType === 'mock') {
  adapter = new MockFileSystemAdapter(config.adapterData as any);
} else {
  throw new Error('Unsupported adapter type');
}

async function run() {
  const result = await generateReportFromAdapter(
    new Set(req.selectedFiles),
    req.fileContents,
    adapter,
    req.rootHandle,
    req.includeFilters,
    req.excludeFilters,
    req.useRegex,
    req.includeProjectTree,
    req.folderSummaryThreshold,
    (path) => parentPort?.postMessage({ type: 'progress', data: { path } })
  );
  parentPort?.postMessage({ type: 'result', data: result });
}

run().catch((err) => {
  parentPort?.postMessage({ type: 'error', data: String(err) });
});
