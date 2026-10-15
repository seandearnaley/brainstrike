// @vitest-environment node
/**
 * BST-2018 (ADR-0021): "Attach to thread" sends `@file` mentions. A run bound
 * to folder A whose prompt mentions a file in folder B, a live workspace
 * folder outside the thread, gets that file as attached content, marked as
 * from outside the thread. It reads exactly the mentioned file, only while B
 * is still live, and every tool use of B is still refused. Each case runs
 * the real admission over a real filesystem; only Main's reads are stood in.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import {
  encodeFileMentionId,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  attachedMentionReader,
  placeMentionedFiles,
} from '../agent-host-platform/desktop-mentioned-files';
import { createDesktopRunAdmission } from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, mainReads } from './fixtures/desktop-admission-reads';

interface Root {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

const MENTIONED = 'BRAVO_MENTIONED_MARKER_2018';
const OTHER = 'BRAVO_OTHER_MARKER_2018';
const ALPHA = 'ALPHA_MENTIONED_MARKER_2018';
const OUTSIDE = "(from bravo, not one of this thread's folders; attached for this run only)";

let directory = '';
let alpha: Root;
let bravo: Root;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-mentioned-files-')));
  alpha = { displayName: 'alpha', path: join(directory, 'alpha'), rootId: 'root-alpha' };
  bravo = { displayName: 'bravo', path: join(directory, 'bravo'), rootId: 'root-bravo' };
  await mkdir(alpha.path);
  await mkdir(join(bravo.path, 'src'), { recursive: true });
  await writeFile(join(alpha.path, 'alpha.txt'), `${ALPHA}\n`);
  await writeFile(join(bravo.path, 'src', 'mentioned.txt'), `${MENTIONED}\n`);
  await writeFile(join(bravo.path, 'other.txt'), `${OTHER}\n`);
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function mention(root: Root, path: string): string {
  return serializeFileMentionDirective({
    id: encodeFileMentionId(root.rootId, path),
    label: path.split('/').at(-1) ?? path,
  });
}

async function admit(options: {
  readonly bound: readonly Root[];
  /** A CLI run's selected folders: the run's whole inventory. */
  readonly cliRootIds?: readonly string[];
  readonly live: readonly Root[];
  readonly prompt: string;
}) {
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
      ...(options.cliRootIds
        ? { cliWorkspace: { instructions: 'off', rootIds: [...options.cliRootIds], skills: 'off' } }
        : {}),
    },
    modelId: 'openai::gpt-6-sol',
    prompt: options.prompt,
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: { operatingRootId: alpha.rootId, operatingRootPath: alpha.path },
  };
  return await admission.readConfiguration(request);
}

test('a file mentioned outside the thread reaches the model as attached content, marked', async () => {
  const selected = await admit({
    bound: [alpha],
    live: [alpha, bravo],
    prompt: `Compare ${mention(alpha, 'alpha.txt')} with ${mention(bravo, 'src/mentioned.txt')}`,
  });
  try {
    expect(selected.system).toContain(ALPHA);
    expect(selected.system).toContain(MENTIONED);
    expect(selected.system).toContain(`### bravo/src/mentioned.txt ${OUTSIDE}`);
    expect(selected.system).not.toContain(OTHER);
    expect(selected.referencedFileFailures).toBeUndefined();
    // The mention attaches a file, not the folder: the thread keeps its binding.
    expect(selected.nativeRuntime.workspaceRoots).toEqual([alpha]);
  } finally {
    await selected.close();
  }
});

test('a mention in a folder that is not live is refused visibly, not read', async () => {
  const selected = await admit({
    bound: [alpha],
    live: [alpha],
    prompt: `Read ${mention(bravo, 'src/mentioned.txt')}`,
  });
  try {
    expect(selected.system).not.toContain(MENTIONED);
    expect(selected.referencedFileFailures).toEqual([
      expect.objectContaining({ path: 'src/mentioned.txt', rootId: bravo.rootId }),
    ]);
  } finally {
    await selected.close();
  }
});

test('a CLI run cannot attach a mention from a live folder it did not select', async () => {
  const selected = await admit({
    bound: [alpha],
    cliRootIds: [alpha.rootId],
    live: [alpha, bravo],
    prompt: `Read ${mention(alpha, 'alpha.txt')} and ${mention(bravo, 'src/mentioned.txt')}`,
  });
  try {
    expect(selected.system).toContain(ALPHA);
    expect(selected.system).not.toContain(MENTIONED);
    expect(selected.referencedFileFailures).toEqual([
      expect.objectContaining({ path: 'src/mentioned.txt', rootId: bravo.rootId }),
    ]);
  } finally {
    await selected.close();
  }
});

test('the attached reader reads only a mentioned file, only while its folder is live', async () => {
  const mentioned = placeMentionedFiles(
    mention(bravo, 'src/mentioned.txt'),
    [alpha],
    [alpha, bravo]
  );
  expect(mentioned.attachedRoots).toEqual([bravo]);
  let live: readonly Root[] = [alpha, bravo];
  const read = attachedMentionReader(mentioned, async () => live, new AbortController().signal);
  await expect(
    read({ requestedPath: 'src/mentioned.txt', rootPath: bravo.path })
  ).resolves.toMatchObject({ content: expect.stringContaining(MENTIONED) });
  await expect(read({ requestedPath: 'other.txt', rootPath: bravo.path })).rejects.toThrow(
    /outside the thread workspace/u
  );
  await expect(read({ requestedPath: 'alpha.txt', rootPath: alpha.path })).rejects.toThrow(
    /outside the thread workspace/u
  );
  live = [alpha];
  await expect(read({ requestedPath: 'src/mentioned.txt', rootPath: bravo.path })).rejects.toThrow(
    /no longer open/u
  );
});

test('a mention in a thread folder is not attached', () => {
  expect(
    placeMentionedFiles(mention(alpha, 'alpha.txt'), [alpha], [alpha, bravo]).attachedRoots
  ).toEqual([]);
});
