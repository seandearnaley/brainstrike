import { refusalError } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import type { HostChildRuns } from './core-child-runs.ts';
import {
  CANVAS_STATE_KEY_PREFIX,
  canvasStateKey,
  type HostCanvasSummary,
  type HostCanvasVersion,
  HostCanvasVersionSchema,
  type HostParams,
  type HostResults,
} from './protocol.ts';
import type { HostToolRecords } from './tool-records.ts';

const decodeVersion = wireDecoder(HostCanvasVersionSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

function readVersion(key: string, value: unknown): HostCanvasVersion {
  const version = decodeVersion(value);
  if (canvasStateKey(version.canvasId) !== key) {
    throw new Error('A committed canvas version is stored under another canvas key');
  }
  return version;
}

/**
 * The Artifacts gallery's reads: every canvas Core's folded tool state holds,
 * at its latest committed version. The run log stays the only record, so a
 * deleted thread's canvases leave the gallery with it.
 */
export function hostCanvases(
  records: Pick<HostToolRecords, 'stateView'>,
  children: Pick<HostChildRuns, 'rootThread'>,
  threads: ReadonlySet<string>
): {
  readonly list: () => HostResults['canvas/list'];
  readonly read: (params: HostParams<'canvas/read'>) => HostResults['canvas/read'];
} {
  return {
    list: () => {
      const canvases: HostCanvasSummary[] = [];
      for (const threadId of threads) {
        const rootThreadId = children.rootThread(threadId);
        for (const [key, value] of records.stateView(threadId).entries(CANVAS_STATE_KEY_PREFIX)) {
          const { canvasId, createdAt, createdBy, title, version } = readVersion(key, value);
          canvases.push({
            canvasId,
            createdBy,
            rootThreadId,
            threadId,
            title,
            updatedAt: createdAt,
            version,
          });
        }
      }
      return { canvases: canvases.sort((l, r) => r.updatedAt.localeCompare(l.updatedAt)) };
    },
    read: ({ canvasId, threadId }) => {
      if (!threads.has(threadId)) {
        throw refusalError('input', 'thread.unknown', 'Unknown thread');
      }
      const key = canvasStateKey(canvasId);
      const value = records.stateView(threadId).read(key);
      return { canvas: value === undefined ? null : readVersion(key, value) };
    },
  };
}
