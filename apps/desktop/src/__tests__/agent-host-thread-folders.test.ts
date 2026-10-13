// @vitest-environment node
/**
 * BST-1990 PR 4: the agent knows which folders it has. Runs admitted from the
 * recorded A2 run (a thread bound to alpha, with bravo open in the workspace
 * but not in the thread) and I4 run (alpha primary, bravo added to the thread)
 * replay the model's recorded tool calls. A grep or glob with no `root`
 * searches every thread folder and no other; writes still go to the primary;
 * an explicit `root` always wins. Each case runs the real admission and the
 * host's real tool binding over a real filesystem; only Main's reads are
 * stood in.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest, HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';
import recorded from './fixtures/thread-folder-tool-calls.json';

interface Root {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}
type Flow = 'A2' | 'I4';

const TOOL_IDS = [
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
];
/** Main's file-chunk index on the recorded fresh profile: no index, so no indexed hits. */
const NO_INDEXED_HITS = {
  candidatesTruncated: false,
  matches: [],
  scanLimited: false,
  skippedMissingLineMetadata: 0,
  totalMatches: 0,
  truncated: false,
};

let directory = '';
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-m6-thread-folders-')));
  // The recorded smoke's seed: each folder holds its own files carrying the needle.
  for (const name of ['alpha', 'bravo']) {
    const root = join(directory, `${name}-root`);
    await mkdir(root);
    await writeFile(join(root, `${name}-only.txt`), `${name} unique line\n${recorded.needle}\n`);
    for (const n of [1, 2]) {
      await writeFile(join(root, `${name}-only-${n}.txt`), `${name} ${n} ${recorded.needle}\n`);
    }
  }
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/** A recorded root, moved to this test's directory. */
function relocate(root: Root): Root {
  return { ...root, path: join(directory, root.displayName) };
}

/** Admit a run from the recorded flow and bind the host's tools to it. */
async function admit(flow: Flow) {
  const run = recorded[flow];
  const bound = run.boundRoots.map(relocate);
  const live = run.liveRoots.map(relocate);
  const [primary] = bound;
  if (!primary) {
    throw new Error(`The recorded ${flow} run binds no folder`);
  }
  const admission = createDesktopRunAdmission(
    mainReads({
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: bound,
      }),
      liveWorkspaceRoots: async () => live,
    }),
    async () => undefined
  );
  const request: HostRunAdmissionRequest = {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      enabledNativeToolIds: TOOL_IDS,
      selectionFolderId: run.selectionFolderId,
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: { ...run.workspaceBinding, operatingRootPath: primary.path },
  };
  const selected = await admission.readConfiguration(request);
  /** The folders each indexed grep asked Main for. */
  const indexScopes: unknown[] = [];
  const mainRequest = async (method: string, input: unknown) => {
    if (method === 'desktop-read/grep-index') {
      const { options } = input as { options: { rootId?: string; rootIds?: string[] } };
      indexScopes.push(options.rootIds ?? (options.rootId ? [options.rootId] : 'every folder'));
      return NO_INDEXED_HITS;
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
  const call = async (id: string, input: Record<string, unknown>): Promise<unknown> => {
    const found = Object.values(tools).find((candidate) => candidate.permissionToolId === id);
    if (!found) {
      throw new Error(`${id} was not built for the host`);
    }
    return await found.execute(input, execution());
  };
  return { bound, call, indexScopes, live, selected };
}

function execution(): HostToolContext {
  return {
    edits: { track: async (_edit, mutate) => await mutate() },
    runId: 'host-run',
    signal: new AbortController().signal,
    state: { entries: () => [], read: async () => undefined, update: async () => undefined },
    threadId: 'host-thread',
    toolCallId: 'thread-folders-call',
  };
}

/** The seeded folders a grep or glob result's rows come from, read from each file's name. */
function rowFolders(output: unknown): string[] {
  const { matches } = output as { matches: { path: string }[] };
  return [...new Set(matches.map((match) => match.path.replace(/^\/?(\w+)-only.*$/, '$1')))].sort();
}

const REFUSED = { error: { code: 'tool_input_invalid' }, ok: false };

test('an unscoped grep searches every folder of the thread (recorded I4 call)', async () => {
  const { bound, call, indexScopes, selected } = await admit('I4');
  try {
    const output = await call(NATIVE_TOOL_ID.grepSearch, recorded.calls.grepNoRoot);
    expect(rowFolders(output)).toEqual(['alpha', 'bravo']);
    // The index is asked for exactly the thread's folders.
    expect(indexScopes).toEqual([bound.map((root) => root.rootId)]);
  } finally {
    await selected.close();
  }
});

test('an unscoped glob lists every folder of the thread', async () => {
  const { call, selected } = await admit('I4');
  try {
    const output = await call(NATIVE_TOOL_ID.globWorkspace, { pattern: '**/*-only.txt' });
    expect(rowFolders(output)).toEqual(['alpha', 'bravo']);
  } finally {
    await selected.close();
  }
});

test('an explicit root still wins, and an unscoped write still goes to the primary', async () => {
  const { bound, call, selected } = await admit('I4');
  const [alpha, bravo] = bound;
  try {
    const grep = await call(NATIVE_TOOL_ID.grepSearch, {
      ...recorded.calls.grepNoRoot,
      root: 'bravo-root',
    });
    expect(rowFolders(grep)).toEqual(['bravo']);
    const glob = await call(NATIVE_TOOL_ID.globWorkspace, {
      pattern: '**/*-only.txt',
      root: 'alpha-root',
    });
    expect(rowFolders(glob)).toEqual(['alpha']);
    const written = await call(NATIVE_TOOL_ID.writeWorkspaceFile, recorded.calls.writeNoRoot);
    expect(written).toMatchObject({ rootId: alpha?.rootId });
    expect(await readFile(join(alpha?.path ?? '', 'smoke-write-1.txt'), 'utf8')).toBe(
      recorded.calls.writeNoRoot.content
    );
    await expect(readFile(join(bravo?.path ?? '', 'smoke-write-1.txt'))).rejects.toThrow();
    // A read without a root reads the primary, where a bravo-only file is missing.
    expect(
      await call(NATIVE_TOOL_ID.readWorkspaceFile, recorded.calls.readOutsideNoRoot)
    ).toMatchObject(REFUSED);
  } finally {
    await selected.close();
  }
});

test('a folder open in the workspace but not in the thread is never searched (recorded A2 calls)', async () => {
  const { bound, call, indexScopes, live, selected } = await admit('A2');
  try {
    expect(live.map((root) => root.displayName)).toEqual(['alpha-root', 'bravo-root']);
    const output = await call(NATIVE_TOOL_ID.grepSearch, recorded.calls.grepNoRoot);
    expect(rowFolders(output)).toEqual(['alpha']);
    expect(indexScopes).toEqual([bound.map((root) => root.rootId)]);
    const glob = await call(NATIVE_TOOL_ID.globWorkspace, { pattern: '**/*-only.txt' });
    expect(rowFolders(glob)).toEqual(['alpha']);
    // Naming the outside folder is the model's typed refusal; so is a read of its file.
    for (const input of [recorded.calls.readOutsideWithRoot, recorded.calls.readOutsideNoRoot]) {
      expect(await call(NATIVE_TOOL_ID.readWorkspaceFile, input)).toMatchObject(REFUSED);
    }
    expect(
      await call(NATIVE_TOOL_ID.grepSearch, { ...recorded.calls.grepNoRoot, root: 'bravo-root' })
    ).toMatchObject(REFUSED);
  } finally {
    await selected.close();
  }
});
