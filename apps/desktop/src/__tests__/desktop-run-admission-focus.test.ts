// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { z } from 'zod';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-client-configuration';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';

interface Root {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

let directory = '';
let alpha: Root;
let bravo: Root;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bs-m6-admission-focus-'));
  alpha = { displayName: 'alpha', path: join(directory, 'alpha'), rootId: 'root-a' };
  bravo = { displayName: 'bravo', path: join(directory, 'bravo'), rootId: 'root-b' };
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/** Main's reads for a thread bound to folder A, with `mounted` the workspace's live folders. */
function admission(mounted: readonly Root[]) {
  return createDesktopRunAdmission(
    mainReads({
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: [alpha],
      }),
      liveWorkspaceRoots: async () => [...mounted],
    }),
    async () => undefined
  );
}

/** A send from a thread bound to folder A while the explorer focuses `focusedRootId`. */
function send(focusedRootId: string): HostRunAdmissionRequest {
  return {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      selectionFolderId: focusedRootId,
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: { operatingRootDisplayName: 'alpha', operatingRootId: 'root-a' },
  };
}

test('a thread bound to folder A runs there while the explorer focuses folder B', async () => {
  const selected = await admission([alpha, bravo]).readConfiguration(send('root-b'));
  try {
    expect(selected.workspace).toEqual({ boundWorkspaceRootId: 'root-a', roots: [alpha] });
    expect(selected.nativeRuntime).toMatchObject({
      boundWorkspaceRootId: 'root-a',
      workspaceRoots: [alpha],
    });
    // Folder B is not one of the thread's folders, so it scopes no selection in this run.
    expect(selected.nativeRuntime).not.toHaveProperty('selectionFolderId');
    expect(selected.nativeRuntime).not.toHaveProperty('workspaceRootPath');
  } finally {
    await selected.close();
  }
});

test('a focus on one of the thread’s folders scopes the run’s selection', async () => {
  const selected = await admission([alpha, bravo]).readConfiguration(send('root-a'));
  try {
    expect(selected.nativeRuntime).toMatchObject({
      boundWorkspaceRootId: 'root-a',
      selectionFolderId: 'root-a',
      workspaceRootPath: alpha.path,
    });
  } finally {
    await selected.close();
  }
});

test('a focus on a folder the workspace no longer mounts refuses the run', async () => {
  await expect(admission([alpha]).readConfiguration(send('root-gone'))).rejects.toThrow(
    'The selected workspace root is no longer mounted'
  );
});

test('an unbound new chat with no mounted folders admits an empty workspace', async () => {
  const request = send('root-gone');
  const selected = await createDesktopRunAdmission(
    mainReads(),
    async () => undefined
  ).readConfiguration({
    configuration: capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
    modelId: request.modelId,
    runId: request.runId,
    signal: request.signal,
    threadId: request.threadId,
  });
  try {
    expect(selected.nativeRuntime.workspaceRoots).toEqual([]);
    expect(selected.nativeRuntime).not.toHaveProperty('selectionFolderId');
    expect(selected.nativeRuntime).not.toHaveProperty('boundWorkspaceRootId');
  } finally {
    await selected.close();
  }
});

test('an explicit selection from an unavailable folder is refused even for an unbound chat', async () => {
  const request = send('root-gone');
  await expect(
    createDesktopRunAdmission(mainReads(), async () => undefined).readConfiguration({
      configuration: z.record(z.string(), z.json()).parse(
        PlatformClientConfigurationSchema.parse({
          ...request.configuration,
          workspaceContext: {
            files: [
              {
                approxTokens: null,
                outputApproxTokens: null,
                path: 'selected.md',
                ranges: [],
                rootId: 'root-gone',
              },
            ],
            includeProjectTree: false,
            projectTreeApproxTokens: null,
            projectTreeTokenCountLoading: false,
            selectedOutputApproxTokens: null,
            selectedSourceApproxTokens: null,
          },
        })
      ),
      modelId: request.modelId,
      runId: request.runId,
      signal: request.signal,
      threadId: request.threadId,
    })
  ).rejects.toThrow();
});

test('a changed model selection returns a typed refusal with a remedy', async () => {
  const request = send('root-a');
  await expect(
    admission([alpha]).readConfiguration({
      ...request,
      configuration: {
        ...request.configuration,
        modelConfiguration: { model: 'other-model', provider: 'openai' },
      },
    })
  ).rejects.toMatchObject({
    failure: {
      category: 'conflict',
      code: 'model.selection-changed',
      kind: 'refusal',
      remedy: 'Select the model again and retry.',
    },
  });
});
