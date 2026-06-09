import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import { addLogListener, configureLogger, LogLevel, resetLogger } from '@brainstrike/utils/logger';
import { afterEach, describe, expect, it } from 'vitest';

import {
  estimateTreePayloadBytes,
  measureFileTreeOperation,
  recordFileTreeTelemetry,
} from '../file-tree-telemetry';

const tree: WorkerFileNode[] = [
  {
    children: [
      {
        depth: 1,
        name: 'secret-plan.md',
        path: '/Users/test/private/secret-plan.md',
        rootFolderId: 'root',
        size: 123,
        type: 'file',
      },
    ],
    depth: 0,
    loadState: 'loaded',
    name: 'private',
    path: '/Users/test/private',
    rootFolderId: 'root',
    type: 'directory',
  },
];

describe('file-tree-telemetry', () => {
  afterEach(() => {
    resetLogger();
  });

  it('estimates payload bytes without returning raw path or filename data', () => {
    const estimate = estimateTreePayloadBytes(tree);

    expect(estimate.nodeCount).toBe(2);
    expect(estimate.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(estimate)).not.toContain('/Users/test/private');
    expect(JSON.stringify(estimate)).not.toContain('secret-plan.md');
  });

  it('accounts for UTF-8 string widths and optional node metadata', () => {
    const estimate = estimateTreePayloadBytes([
      {
        depth: 0,
        lastModified: 1_717_000_000,
        loadError: 'é€😀',
        loadState: 'error',
        name: 'é€😀',
        path: '/root/é€😀.txt',
        rootFolderId: 'root',
        size: 64,
        type: 'file',
      },
    ]);

    expect(estimate).toEqual({
      bytes: 74,
      nodeCount: 1,
    });
  });

  it('skips empty stack entries while estimating malformed worker payloads', () => {
    const estimate = estimateTreePayloadBytes([undefined] as unknown as WorkerFileNode[]);

    expect(estimate).toEqual({
      bytes: 0,
      nodeCount: 0,
    });
  });

  it('records only coarse metric metadata', () => {
    configureLogger({ console: false, level: LogLevel.DEBUG });
    const records: unknown[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      recordFileTreeTelemetry({
        bytes: 2048,
        durationMs: 12.4,
        event: 'file-tree.snapshot',
        kind: 'full',
        nodeCount: 2,
      });
    } finally {
      unsubscribe();
    }

    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain('file-tree.snapshot');
    expect(JSON.stringify(records[0])).toContain('2048');
    expect(JSON.stringify(records[0])).not.toContain('/Users/test/private');
    expect(JSON.stringify(records[0])).not.toContain('secret-plan.md');
  });

  it('measures operation duration and returns the operation result', () => {
    const measured = measureFileTreeOperation(() => ['row-a', 'row-b']);

    expect(measured.result).toEqual(['row-a', 'row-b']);
    expect(measured.durationMs).toBeGreaterThanOrEqual(0);
  });
});
