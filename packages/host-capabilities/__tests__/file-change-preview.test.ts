/**
 * ADR-0036: a waiting file call's approval shows the change the call would
 * make. The preview runs the tool's own resolution, checks and matcher against
 * the real file, and never writes: what it shows is what the tool then writes.
 */
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import type { HostTool, HostToolContext } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createSharedNativeHostTools,
  EDIT_FAILURE_HINT_MESSAGE,
  ReadWorkspaceFileCursorRegistry,
  resetToolCallLoopGuards,
  runStringReplaceWorkspaceFile,
} from '../src/native-tools/index.js';

let root = '';

beforeEach(async () => {
  resetToolCallLoopGuards();
  root = await realpath(await mkdtemp(join(tmpdir(), 'bs-file-change-preview-')));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function fileTool(id: string): HostTool {
  const tools = createSharedNativeHostTools({
    ids: [
      NATIVE_TOOL_ID.deleteWorkspaceFile,
      NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
      NATIVE_TOOL_ID.writeWorkspaceFile,
    ],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: {
      model: 'scripted',
      provider: 'openai',
      workspaceRoots: [{ displayName: 'project', path: root, rootId: 'r-project' }],
    },
  });
  const found = Object.values(tools).find((tool) => tool.permissionToolId === id);
  if (!found) {
    throw new Error(`${id} was not built`);
  }
  return found;
}

function preview(id: string, input: unknown) {
  const proposedChange = fileTool(id).proposedChange;
  if (!proposedChange) {
    throw new Error(`${id} has no preview`);
  }
  return proposedChange(input, new AbortController().signal);
}

/** The tool's real execute, as Core dispatches an approved call. */
function execute(id: string, input: unknown): Promise<unknown> {
  const context: HostToolContext = {
    edits: { track: (_edit, mutate) => mutate() },
    runId: 'run-1',
    signal: new AbortController().signal,
    state: { entries: () => [], read: () => undefined, update: async () => undefined },
    threadId: 'thread-1',
    toolCallId: 'call-1',
  };
  return fileTool(id).execute(input, context);
}

async function fileAt(relative: string): Promise<{ content: string; mtimeMs: number }> {
  const path = join(root, relative);
  return { content: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs };
}

test('a write to a new path creates the file; the preview does not', async () => {
  await expect(
    preview(NATIVE_TOOL_ID.writeWorkspaceFile, { content: 'hello\n', path: 'notes/new.md' })
  ).resolves.toEqual({ after: 'hello\n', before: null, path: 'notes/new.md' });
  await expect(stat(join(root, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a write over a file replaces its text, and the file is untouched until it runs', async () => {
  await writeFile(join(root, 'a.txt'), 'old\n');
  const untouched = await fileAt('a.txt');
  await expect(
    preview(NATIVE_TOOL_ID.writeWorkspaceFile, { content: 'new\n', path: '/a.txt' })
  ).resolves.toEqual({ after: 'new\n', before: 'old\n', path: '/a.txt' });
  expect(await fileAt('a.txt')).toEqual(untouched);
});

test.each([
  { edit: { newStr: 'return 2;', oldStr: 'return 1;' }, exact: true },
  {
    // Indented differently from the file: only the matcher's fuzzy cascade finds it.
    edit: { newStr: 'if (ready) {\n  return 2;\n}', oldStr: 'if (ready) {\n  return 1;\n}' },
    exact: false,
  },
])(
  'a replacement (exact: $exact) previews the text the tool then writes',
  async ({ edit, exact }) => {
    const source = 'function f(ready) {\n    if (ready) {\n        return 1;\n    }\n}\n';
    await writeFile(join(root, 'f.js'), source);
    const untouched = await fileAt('f.js');
    const input = { ...edit, path: 'f.js' };
    const change = await preview(NATIVE_TOOL_ID.stringReplaceWorkspaceFile, input);
    expect(change).toMatchObject({ before: source, path: 'f.js' });
    expect(change.after).not.toBe(source);
    expect(await fileAt('f.js')).toEqual(untouched);

    const result = await execute(NATIVE_TOOL_ID.stringReplaceWorkspaceFile, input);
    expect((result as { matchType: string }).matchType === 'exact').toBe(exact);
    expect((await fileAt('f.js')).content).toBe(change.after);
  }
);

test("a replacement the matcher refuses is the matcher's own refusal, and no failed edit", async () => {
  await writeFile(join(root, 'config.txt'), 'enabled=true\n');
  const untouched = await fileAt('config.txt');
  const missing = { newStr: 'missing=true', oldStr: 'missing=false', path: 'config.txt' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(preview(NATIVE_TOOL_ID.stringReplaceWorkspaceFile, missing)).rejects.toMatchObject(
      {
        failure: {
          code: 'approval.preview-edit-refused',
          kind: 'refusal',
          message: expect.stringContaining('No sufficiently close match for oldStr'),
        },
      }
    );
  }
  // Previews are not the model's failed edits: only its third real miss escalates.
  const miss = () =>
    runStringReplaceWorkspaceFile(
      missing,
      { workspaceRoots: [{ displayName: 'project', path: root, rootId: 'r-project' }] },
      { edits: () => ({ track: (_edit, mutate) => mutate() }) },
      'call-1',
      'thread-1'
    );
  const unescalated = { message: expect.not.stringContaining(EDIT_FAILURE_HINT_MESSAGE) };
  await expect(miss()).rejects.toMatchObject(unescalated);
  await expect(miss()).rejects.toMatchObject(unescalated);
  await expect(miss()).rejects.toThrow(EDIT_FAILURE_HINT_MESSAGE);
  expect(await fileAt('config.txt')).toEqual(untouched);
});

test('a delete removes the whole text, and the file stays until it runs', async () => {
  await writeFile(join(root, 'gone.md'), '# Gone\n');
  const untouched = await fileAt('gone.md');
  await expect(preview(NATIVE_TOOL_ID.deleteWorkspaceFile, { path: 'gone.md' })).resolves.toEqual({
    after: null,
    before: '# Gone\n',
    path: 'gone.md',
  });
  expect(await fileAt('gone.md')).toEqual(untouched);
});

test('a delete of a symlink removes the link, whose text is the path it points to', async () => {
  await writeFile(join(root, 'target.md'), 'kept\n');
  await symlink('target.md', join(root, 'link.md'));
  await expect(preview(NATIVE_TOOL_ID.deleteWorkspaceFile, { path: 'link.md' })).resolves.toEqual({
    after: null,
    before: 'target.md',
    path: 'link.md',
  });
});

test('a file that is not text has no text preview', async () => {
  await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  const notText = {
    failure: {
      code: 'approval.preview-not-text',
      kind: 'refusal',
      message: 'Path "image.bin" is a binary file and cannot be read as text.',
    },
  };
  await expect(
    preview(NATIVE_TOOL_ID.writeWorkspaceFile, { content: 'text', path: 'image.bin' })
  ).rejects.toMatchObject(notText);
  await expect(
    preview(NATIVE_TOOL_ID.deleteWorkspaceFile, { path: 'image.bin' })
  ).rejects.toMatchObject(notText);
});

test('a file the agent may not change is refused as its tool refuses it', async () => {
  await writeFile(join(root, '.llmignore'), 'secrets/\n');
  await expect(
    preview(NATIVE_TOOL_ID.writeWorkspaceFile, { content: 'x', path: 'secrets/key.ts' })
  ).rejects.toThrow(
    'excluded by an agent ignore file (.llmignore/.brainstrikeignore) and cannot be changed'
  );
  await writeFile(join(root, '.env'), 'TOKEN=do-not-read\n');
  await expect(preview(NATIVE_TOOL_ID.deleteWorkspaceFile, { path: '.env' })).rejects.toThrow(
    'is a credential file'
  );
});
