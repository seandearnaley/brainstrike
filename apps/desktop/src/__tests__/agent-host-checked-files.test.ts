// @vitest-environment node
/**
 * BST-1990 PR 3: checked files reach the model. A run admitted from the
 * recorded K11 intent (a thread bound to A, a file checked in B outside the
 * thread) gives the agent B's checked file as attached content, marked as from
 * outside the thread, while every tool use of B is still refused by type. Each
 * case runs the real admission and the host's real tool binding over a real
 * filesystem; only Main's reads are stood in.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest, HostTool, HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import recorded from './fixtures/checked-file-outside-thread-intent.json';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';

interface Root {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

const CHECKED = 'BRAVO_CHECKED_MARKER_1990';
const OTHER = 'BRAVO_OTHER_MARKER_1990';
const ALPHA = 'ALPHA_CHECKED_MARKER_1990';
const TOOL_IDS = [
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.listWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
];

let directory = '';
let alpha: Root;
let bravo: Root;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-m6-checked-files-')));
  alpha = { displayName: 'alpha', path: join(directory, 'alpha'), rootId: recorded.alpha.rootId };
  bravo = { displayName: 'bravo', path: join(directory, 'bravo'), rootId: recorded.bravo.rootId };
  await mkdir(alpha.path);
  await mkdir(bravo.path);
  await writeFile(join(alpha.path, 'alpha-checked.txt'), `${ALPHA}\n`);
  await writeFile(join(bravo.path, 'bravo-checked.txt'), `${CHECKED}\n`);
  await writeFile(join(bravo.path, 'bravo-other.txt'), `${OTHER}\n`);
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/** The recorded run's selection, with its folders moved to this test's directories. */
function recordedSelection() {
  const relocate = (value: string): string =>
    value.replace(recorded.alpha.path, alpha.path).replace(recorded.bravo.path, bravo.path);
  return {
    selectionFolderId: recorded.selectionFolderId,
    workspaceBinding: { ...recorded.workspaceBinding, operatingRootPath: alpha.path },
    workspaceContext: {
      ...recorded.workspaceContext,
      files: recorded.workspaceContext.files.map((file) => ({
        ...file,
        path: relocate(file.path),
      })),
    },
  };
}

/** Admit a run from the recorded selection, with `bound` the thread's folders and `live` the workspace's. */
async function admit(options: {
  readonly bound: readonly Root[];
  readonly live: readonly Root[];
  readonly selection?: ReturnType<typeof recordedSelection>;
  /** The live folders Main reports to a read after admission; defaults to `live`. */
  readonly liveAtRead?: () => readonly Root[];
}) {
  const selection = options.selection ?? recordedSelection();
  const admission = createDesktopRunAdmission(
    mainReads({
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: [...options.bound],
      }),
      liveWorkspaceRoots: async () => [...options.live],
    }),
    async () => undefined
  );
  const request: HostRunAdmissionRequest = {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      enabledNativeToolIds: TOOL_IDS,
      selectionFolderId: selection.selectionFolderId,
      workspaceContext: selection.workspaceContext,
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: {
      ...selection.workspaceBinding,
      ...(options.bound.length > 1
        ? { secondaryRootIds: options.bound.slice(1).map((root) => root.rootId) }
        : {}),
    },
  };
  const selected = await admission.readConfiguration(request);
  const mainRequest = async (method: string) => {
    if (method === 'platform/admission/roots') {
      return [...(options.liveAtRead?.() ?? options.live)];
    }
    if (method === 'desktop-read/index/status') {
      return { kind: 'unavailable', reason: 'No index in this scenario' };
    }
    throw new Error(`Unexpected Main request ${method}`);
  };
  const tools = desktopHostSharedTools({
    freshRoots: () => selected.freshWorkspaceRoots(),
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request: mainRequest,
    resolveTavilyApiKey: async () => undefined,
    selected,
    threadId: 'host-thread',
  });
  return { selected, tools };
}

function execution(): HostToolContext {
  return {
    edits: { track: async (_edit, mutate) => await mutate() },
    runId: 'host-run',
    signal: new AbortController().signal,
    state: { entries: () => [], read: async () => undefined, update: async () => undefined },
    threadId: 'host-thread',
    toolCallId: 'checked-files-call',
  };
}

function tool(tools: Record<string, HostTool>, id: string): HostTool {
  const found = Object.values(tools).find((candidate) => candidate.permissionToolId === id);
  if (!found) {
    throw new Error(`${id} was not built for the host`);
  }
  return found;
}

test('a file checked outside the thread reaches the model as attached content, marked (recorded K11 intent)', async () => {
  const { selected, tools } = await admit({ bound: [alpha], live: [alpha, bravo] });
  try {
    const output = await tool(tools, NATIVE_TOOL_ID.readWorkspaceContext).execute({}, execution());
    expect(output).toMatchObject({
      files: [
        expect.objectContaining({
          content: expect.stringContaining(CHECKED),
          outsideThread: true,
          path: '/bravo-checked.txt',
          rootName: 'bravo',
        }),
      ],
    });
    expect(JSON.stringify(output)).toContain('not one of this thread');
    // The listing counts it outside the thread's selection and says it is attached.
    const listed = await tool(tools, NATIVE_TOOL_ID.listWorkspaceContext).execute({}, execution());
    expect(listed).toMatchObject({
      hint: expect.stringContaining('readWorkspaceContext attaches it for this run only'),
      selectedFileCount: 0,
      selectedFilesOutsideWorkspace: 1,
    });
    // The binding, not the checked file, decides the thread's folders.
    expect(selected.nativeRuntime.workspaceRoots).toEqual([alpha]);
  } finally {
    await selected.close();
  }
});

test('every tool use of the outside folder is still refused by type', async () => {
  const { selected, tools } = await admit({ bound: [alpha], live: [alpha, bravo] });
  try {
    const refusals = await Promise.all([
      tool(tools, NATIVE_TOOL_ID.readWorkspaceFile).execute(
        { path: 'bravo-checked.txt', root: 'bravo' },
        execution()
      ),
      tool(tools, NATIVE_TOOL_ID.readWorkspaceFile).execute(
        { path: 'bravo-other.txt', root: 'bravo' },
        execution()
      ),
      tool(tools, NATIVE_TOOL_ID.writeWorkspaceFile).execute(
        { content: 'x', path: 'new.txt', root: 'bravo' },
        execution()
      ),
      tool(tools, NATIVE_TOOL_ID.grepSearch).execute(
        { outputMode: 'files', pattern: 'MARKER', root: 'bravo' },
        execution()
      ),
    ]);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ error: { code: 'tool_input_invalid' }, ok: false });
    }
  } finally {
    await selected.close();
  }
});

test('checked files in every thread folder arrive, whichever folder is focused', async () => {
  const selection = recordedSelection();
  const [bravoFile] = selection.workspaceContext.files;
  if (!bravoFile) {
    throw new Error('The recorded intent has no checked file');
  }
  const { selected, tools } = await admit({
    bound: [alpha, bravo],
    live: [alpha, bravo],
    selection: {
      ...selection,
      selectionFolderId: alpha.rootId,
      workspaceContext: {
        ...selection.workspaceContext,
        files: [
          bravoFile,
          {
            ...bravoFile,
            path: join(alpha.path, 'alpha-checked.txt'),
            rootDisplayName: 'alpha',
            rootId: alpha.rootId,
          },
        ],
      },
    },
  });
  try {
    const output = await tool(tools, NATIVE_TOOL_ID.readWorkspaceContext).execute({}, execution());
    const serialized = JSON.stringify(output);
    expect(serialized).toContain(CHECKED);
    expect(serialized).toContain(ALPHA);
    expect(serialized).not.toContain('not one of this thread');
    const listed = await tool(tools, NATIVE_TOOL_ID.listWorkspaceContext).execute({}, execution());
    expect(listed).toMatchObject({
      selectedFiles: ['bravo:/bravo-checked.txt', 'alpha:/alpha-checked.txt'],
    });
    expect(listed).not.toHaveProperty('selectedFilesOutsideWorkspace');
  } finally {
    await selected.close();
  }
});

test('a checked file whose folder stops being live is skipped and reported, never read', async () => {
  let live: readonly Root[] = [alpha, bravo];
  const { selected, tools } = await admit({
    bound: [alpha],
    live: [alpha, bravo],
    liveAtRead: () => live,
  });
  try {
    live = [alpha];
    const output = await tool(tools, NATIVE_TOOL_ID.readWorkspaceContext).execute({}, execution());
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(CHECKED);
    expect(output).toMatchObject({
      skippedFiles: [
        expect.objectContaining({ path: '/bravo-checked.txt', reason: 'folderUnavailable' }),
      ],
    });
  } finally {
    await selected.close();
  }
});
