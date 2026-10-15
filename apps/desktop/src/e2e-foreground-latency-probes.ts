/**
 * E2E-only seam for the loaded foreground-latency benchmark (BST-1925, BST-2012,
 * `e2e/foreground-latency-under-index-build.desktop.test.ts`).
 *
 * The benchmark times two foreground operations through their current owners,
 * from the main process, which brokers both for the app:
 *
 * - the chat path's per-step write: one committed agent-host command
 *   (`thread/update` of a probe thread's title) through main's own host
 *   client. Like every run event, it is one append through the host's single
 *   StateStore writer, so it waits on whatever that writer and the host are
 *   doing;
 * - an agent tool's read: the shared tool file reader, then the grep tool's
 *   index half (`nativeGrepIndex` over the native index's query host), scoped
 *   to one file path.
 *
 * In E2E test mode main exposes exactly these calls on a global. Nothing here
 * changes app behaviour.
 */
import { randomUUID } from 'node:crypto';
import type { HostMethod, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import type { GrepIndexSearch } from './assistant-server/grep-search-core';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

const E2E_FOREGROUND_LATENCY_PROBES_KEY = '__brainstrike_e2e_foreground_latency_probes__';

interface E2eForegroundLatencyProbes {
  /** The chat path's write: one committed title update of the probe thread. */
  readonly commitThreadUpdate: (input: {
    readonly threadId: string;
    readonly title: string;
  }) => Promise<void>;
  /** The grep tool's index pass, scoped to one file path. Resolves with the match count. */
  readonly grepToolIndex: (input: {
    readonly filePath: string;
    readonly pattern: string;
  }) => Promise<number>;
  /** The shared tool file reader. Resolves with the file size in bytes. */
  readonly readToolFile: (input: {
    readonly requestedPath: string;
    readonly rootPath: string;
  }) => Promise<number>;
  /** Starts the host thread the chat-path probe updates. Resolves with its id. */
  readonly startProbeThread: () => Promise<string>;
}

interface E2eForegroundLatencyProbeOwners {
  readonly grepIndex: GrepIndexSearch;
  readonly hostRequest: <M extends HostMethod>(
    method: M,
    params: HostParams<M>
  ) => Promise<HostResults[M]>;
}

export function installE2eForegroundLatencyProbes(owners: E2eForegroundLatencyProbeOwners): void {
  if (!isElectronE2ETestMode()) {
    throw new Error('Foreground latency probes exist only in Electron E2E test mode.');
  }
  const probes: E2eForegroundLatencyProbes = {
    commitThreadUpdate: async ({ threadId, title }) => {
      await owners.hostRequest('thread/update', { commandId: randomUUID(), threadId, title });
    },
    grepToolIndex: async ({ filePath, pattern }) => {
      const result = await owners.grepIndex({ contextLines: 0, filePaths: [filePath], pattern });
      return result.totalMatches;
    },
    readToolFile: async ({ requestedPath, rootPath }) => {
      const file = await readWorkspaceTextFile({ requestedPath, rootPath });
      return file.size;
    },
    startProbeThread: async () =>
      (await owners.hostRequest('thread/start', { commandId: randomUUID() })).threadId,
  };
  (globalThis as Record<string, unknown>)[E2E_FOREGROUND_LATENCY_PROBES_KEY] =
    Object.freeze(probes);
}
