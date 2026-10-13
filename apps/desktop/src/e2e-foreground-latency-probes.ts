/**
 * E2E-only foreground benchmark seams. Workspace-index qualification measures
 * public Main-owner host admission and authorized native grep. The distinct
 * thread-embedding instrument retains explicitly labelled legacy DB operations
 * to preserve its fixed workload. Core remains the only host run writer.
 */

import type { AssistantRunEvent } from '@brainstrike/agent';
import { attachAgentHost } from '@brainstrike/agent-host/client';
import type { HostParams } from '@brainstrike/agent-host/protocol';
import { FileChunkRepository, GrepSearchService } from '@brainstrike/db';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import type { HostAttachment } from '@brainstrike/host-lease';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { AgentHostMainClient } from './agent-host-main-client';
import { nativeGrepIndex } from './agent-host-platform/native-grep-index';
import { recordDesktopAssistantRunEvent } from './assistant-server/run-persistence';
import { getDatabase } from './db-main';
import { createHostAdmissionProbe, type HostAdmissionProbe } from './e2e-host-admission-probe';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const E2E_FOREGROUND_LATENCY_PROBES_KEY = '__brainstrike_e2e_foreground_latency_probes__';

interface E2eForegroundLatencyProbes {
  closeHostProbe(): Promise<void>;
  /** The grep tool's index pass, scoped to one file path. Resolves with the candidate match count. */
  readonly grepToolIndex: (input: {
    readonly embeddingSetId: string;
    readonly filePath: string;
    readonly pattern: string;
  }) => Promise<number>;
  hostRunAdmission(input: HostParams<'run/start'>): Promise<number>;
  nativeToolIndex(input: {
    readonly rootIds: readonly string[];
    readonly embeddingSetId: string;
    readonly filePath: string;
    readonly pattern: string;
  }): Promise<number>;
  prepareHostProbe(threadId: string): Promise<void>;
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

export function installE2eForegroundLatencyProbes(dependencies: {
  readonly acquireProfile: () => Promise<HostAttachment>;
  readonly hostRequest: AgentHostMainClient['request'];
  readonly index: IndexSearchCapability;
}): void {
  if (!isElectronE2ETestMode()) {
    throw new Error('Foreground latency probes exist only in Electron E2E test mode.');
  }
  let hostProbe: HostAdmissionProbe | undefined;
  const probes: E2eForegroundLatencyProbes = {
    closeHostProbe: async () => {
      await hostProbe?.close();
      hostProbe = undefined;
    },
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
    hostRunAdmission: (input) => {
      if (!hostProbe) {
        throw new Error('Host admission probe has not been prepared');
      }
      return hostProbe.run(input);
    },
    nativeToolIndex: async ({ rootIds, embeddingSetId, filePath, pattern }) => {
      const result = await nativeGrepIndex(dependencies.index)({
        contextLines: 0,
        embeddingSetId,
        filePaths: [filePath],
        pattern,
        rootIds: [...rootIds],
      });
      return result.totalMatches;
    },
    prepareHostProbe: async (threadId) => {
      const observer = await attachAgentHost((await dependencies.acquireProfile()).record);
      hostProbe = await createHostAdmissionProbe({
        now: () => performance.now(),
        observer: {
          close: () => observer.close(),
          closed: observer.closed,
          onEvent: (listener) => observer.onEvent(listener),
          subscribe: async (id) => {
            await observer.request('log/subscribe', { fromSeq: 0, threadId: id });
          },
        },
        request: (input) => dependencies.hostRequest('run/start', input),
        threadId,
      });
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
