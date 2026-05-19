import type { WorkerFileNode } from '@brainstrike/file-tree-worker';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('FileTreeTelemetry');

export type FileTreeTelemetryEventName =
  | 'file-tree.flatten'
  | 'file-tree.patch'
  | 'file-tree.rehydrate'
  | 'file-tree.row-build'
  | 'file-tree.snapshot';

export type FileTreeTelemetryKind = 'full' | 'patch';

export interface FileTreePayloadEstimate {
  bytes: number;
  nodeCount: number;
}

export interface FileTreeTelemetryMetric {
  bytes?: number;
  durationMs?: number;
  event: FileTreeTelemetryEventName;
  kind?: FileTreeTelemetryKind;
  nodeCount?: number;
  rowCount?: number;
  source?: 'main-thread' | 'normalized' | 'worker';
}

export interface MeasuredFileTreeOperation<T> {
  durationMs: number;
  result: T;
}

function stringByteLength(value: string): number {
  let bytes = 0;
  // Avoid TextEncoder allocation here because snapshot estimation can visit
  // thousands of path/name strings during worker-backed tree operations.
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7_ff) {
      bytes += 2;
    } else if (codePoint <= 0xff_ff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function estimateNodeBytes(node: WorkerFileNode): number {
  let bytes = 0;
  bytes += stringByteLength(node.name);
  bytes += stringByteLength(node.path);
  bytes += stringByteLength(node.rootFolderId);
  bytes += stringByteLength(node.type);
  bytes += node.loadState ? stringByteLength(node.loadState) : 0;
  bytes += node.loadError ? stringByteLength(node.loadError) : 0;
  bytes += typeof node.depth === 'number' ? 8 : 0;
  bytes += typeof node.lastModified === 'number' ? 8 : 0;
  bytes += typeof node.size === 'number' ? 8 : 0;
  return bytes;
}

export function estimateTreePayloadBytes(
  nodes: readonly WorkerFileNode[]
): FileTreePayloadEstimate {
  let bytes = 0;
  let nodeCount = 0;
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }

    nodeCount += 1;
    bytes += estimateNodeBytes(node);

    if (node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }

  return {
    bytes,
    nodeCount,
  };
}

export function measureFileTreeOperation<T>(operation: () => T): MeasuredFileTreeOperation<T> {
  const startedAt = performance.now();
  const result = operation();
  return {
    durationMs: performance.now() - startedAt,
    result,
  };
}

export function recordFileTreeTelemetry(metric: FileTreeTelemetryMetric): void {
  logger.debug('File tree telemetry', metric);
}
