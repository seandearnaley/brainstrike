// @vitest-environment node
/**
 * ADR-0040: a desktop run in a trusted project gets the project's memory: the
 * memory tool, and its index after the stable instructions. A run whose
 * folder is not trusted gets neither. The real admission runs over a real
 * folder, project and memory; only Main's reads and the trust answer are
 * stood in.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  ProjectMemoryNotes,
  readRunProjectMemory,
} from '@brainstrike/host-capabilities/project-memory';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createDesktopRunAdmission,
  type DesktopTrustedRoots,
} from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, everyRootTrusted, mainReads } from './fixtures/desktop-admission-reads';

let directory = '';
let store: StateStore;
let folder = { displayName: 'beaker', path: '', rootId: 'root-beaker' };

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-admission-memory-')));
  const home = join(directory, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  folder = { ...folder, path: join(directory, 'beaker') };
  await mkdir(folder.path);
  store = await StateStore.open(join(directory, 'profile'));
  const { roots } = await store.workspaceRoots({
    operation: 'register',
    root: {
      canonicalPath: folder.path,
      displayName: folder.displayName,
      path: folder.path,
      preferredId: folder.rootId,
    },
  });
  await new ProjectMemoryNotes(store.root, roots[0]?.projectId ?? '').execute(
    {
      command: 'create',
      file_text: "# Test runtime\nThis repo's tests need Node 26.\n",
      path: '/memories/test-runtime.md',
    },
    { untrusted: false }
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await store.close();
  await rm(directory, { force: true, recursive: true });
});

async function admit(trustedRoots: DesktopTrustedRoots) {
  const admission = createDesktopRunAdmission(
    mainReads({
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: [folder],
      }),
      liveWorkspaceRoots: async () => [folder],
    }),
    async () => undefined,
    trustedRoots,
    (input) => readRunProjectMemory({ ...input, store })
  );
  const request: HostRunAdmissionRequest = {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      // The person keeps the memory tool on, as every new tool starts.
      enabledNativeToolIds: [NATIVE_TOOL_ID.memory],
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: {
      operatingRootDisplayName: folder.displayName,
      operatingRootId: folder.rootId,
      operatingRootPath: folder.path,
    },
  };
  const selected = await admission.readConfiguration(request);
  try {
    return {
      notes: selected.projectMemory,
      system: selected.system ?? '',
      tools: Object.values(selected.tools).map((tool) => tool.permissionToolId),
    };
  } finally {
    await selected.close();
  }
}

test('a run in a trusted project gets its memory tool and its index after the instructions', async () => {
  const run = await admit(everyRootTrusted);

  expect(run.tools).toContain(NATIVE_TOOL_ID.memory);
  expect(run.notes).toBeDefined();
  const section = run.system.indexOf('# Project memory');
  expect(section).toBeGreaterThan(0);
  expect(run.system.slice(section)).toContain(
    "- [Test runtime](test-runtime.md) — This repo's tests need Node 26."
  );
});

test('a run whose folder is not trusted gets no memory tool and no index', async () => {
  const run = await admit(async () => []);

  expect(run.tools).not.toContain(NATIVE_TOOL_ID.memory);
  expect(run.notes).toBeUndefined();
  expect(run.system).not.toContain('# Project memory');
  expect(run.system).not.toContain('Test runtime');
});
