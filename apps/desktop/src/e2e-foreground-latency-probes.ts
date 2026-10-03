/**
 * E2E-only seam for the loaded foreground-latency benchmark (BST-1925,
 * `e2e/foreground-latency-under-index-build.desktop.test.ts`).
 *
 * The benchmark times two foreground operations that live in the main process
 * and have no renderer path with the same shape:
 *
 * - the chat path's per-step database write: one `run.step.finished` event
 *   through `recordDesktopAssistantRunEvent`, which runs on the foreground lane
 *   of the desktop `DatabaseWorkScheduler` and then on the DB host;
 * - an agent tool's read: the shared tool file reader, then a file-scoped grep
 *   through the same repository and service `grep-search-tool.ts` builds, on
 *   the raw main-process database handle (that tool does not use the
 *   scheduler).
 *
 * A renderer `db.query` would add a renderer hop to both and put the tool read
 * on a scheduler lane the tool never uses, so in E2E test mode main exposes
 * exactly these two calls on a global. Nothing here changes app behaviour.
 */
import type { AssistantRunEvent } from '@brainstrike/agent';
import { FileChunkRepository, GrepSearchService } from '@brainstrike/db';
import { recordDesktopAssistantRunEvent } from './assistant-server/run-persistence';
import { readWorkspaceTextFile } from './assistant-server/workspace-text-file-reader';
import { getDatabase } from './db-main';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const E2E_FOREGROUND_LATENCY_PROBES_KEY = '__brainstrike_e2e_foreground_latency_probes__';

interface E2eForegroundLatencyProbes {
  /** The grep tool's index pass, scoped to one file path. Resolves with the candidate match count. */
  readonly grepToolIndex: (input: {
    readonly embeddingSetId: string;
    readonly filePath: string;
    readonly pattern: string;
  }) => Promise<number>;
  /** The shared tool file reader. Resolves with the file size in bytes. */
  readonly readToolFile: (input: {
    readonly requestedPath: string;
    readonly rootPath: string;
  }) => Promise<number>;
  /** The chat path's per-step write: one `run.step.finished` event for an existing run row. */
  readonly writeRunStepEvent: (input: {
    readonly eventId: string;
    readonly runId: string;
    readonly sequence: number;
  }) => Promise<void>;
}

export function installE2eForegroundLatencyProbes(): void {
  if (!isElectronE2ETestMode()) {
    throw new Error('Foreground latency probes exist only in Electron E2E test mode.');
  }
  const probes: E2eForegroundLatencyProbes = {
    grepToolIndex: async ({ embeddingSetId, filePath, pattern }) => {
      const service = new GrepSearchService(new FileChunkRepository(await getDatabase()));
      const result = await service.search({
        contextLines: 0,
        embeddingSetId,
        filePaths: [filePath],
        pattern,
      });
      return result.totalMatches;
    },
    readToolFile: async ({ requestedPath, rootPath }) => {
      const file = await readWorkspaceTextFile({ requestedPath, rootPath });
      return file.size;
    },
    writeRunStepEvent: async ({ eventId, runId, sequence }) => {
      // The shape `agent-streaming.ts` mints for a finished step: makeStepMetadata
      // fields plus the step's own finishReason.
      const event: AssistantRunEvent = {
        id: eventId,
        kind: 'run.step.finished',
        label: 'Generation step completed',
        metadata: {
          completionTokens: 180,
          finishReason: 'tool-calls',
          messageId: `${runId}-message`,
          promptTokens: 12_000,
        },
        sequence,
        status: 'completed',
        timestamp: new Date().toISOString(),
      };
      await recordDesktopAssistantRunEvent(runId, event, getDatabase);
    },
  };
  (globalThis as Record<string, unknown>)[E2E_FOREGROUND_LATENCY_PROBES_KEY] =
    Object.freeze(probes);
}
