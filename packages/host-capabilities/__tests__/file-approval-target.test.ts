/**
 * BST-1990 (D4): a file tool tells Core which folder its call targets, through
 * the same resolver its execute uses, so the approval can name it. A bound
 * thread's omitted root is its primary; an explicit root wins; a root the run
 * cannot use names nothing (the call itself is refused when it executes).
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILING_SCALED_TOOL_RESULT_BUDGET } from '@brainstrike/agent/tool-runtime';
import type { HostTool } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createSharedNativeHostTools,
  ReadWorkspaceFileCursorRegistry,
} from '../src/native-tools/index.js';

let directory = '';
let roots: { displayName: string; path: string; rootId: string }[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-m6-approval-target-')));
  roots = [
    { displayName: 'alpha-root', path: join(directory, 'alpha'), rootId: 'r-alpha' },
    { displayName: 'bravo-root', path: join(directory, 'bravo'), rootId: 'r-bravo' },
  ];
  for (const root of roots) {
    await mkdir(root.path);
  }
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function tools(): Record<string, HostTool> {
  return createSharedNativeHostTools({
    ids: [
      NATIVE_TOOL_ID.writeWorkspaceFile,
      NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
      NATIVE_TOOL_ID.manageTaskList,
    ],
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
    runtime: {
      boundWorkspaceRootId: 'r-alpha',
      model: 'scripted',
      provider: 'openai',
      workspaceRoots: roots,
    },
  });
}

function byId(all: Record<string, HostTool>, id: string): HostTool {
  const found = Object.values(all).find((candidate) => candidate.permissionToolId === id);
  if (!found) {
    throw new Error(`${id} was not built`);
  }
  return found;
}

test("a write with no root targets the bound thread's primary folder", () => {
  const write = byId(tools(), NATIVE_TOOL_ID.writeWorkspaceFile);
  expect(write.approvalTarget?.({ content: 'x', path: 'notes.md' })).toEqual({
    displayName: 'alpha-root',
    rootId: 'r-alpha',
  });
});

test('an explicit root wins, by name or by id', () => {
  const replace = byId(tools(), NATIVE_TOOL_ID.stringReplaceWorkspaceFile);
  const edit = { newStr: 'b', oldStr: 'a', path: 'notes.md' };
  expect(replace.approvalTarget?.({ ...edit, root: 'bravo-root' })).toEqual({
    displayName: 'bravo-root',
    rootId: 'r-bravo',
  });
  expect(replace.approvalTarget?.({ ...edit, root: 'r-bravo' })).toEqual({
    displayName: 'bravo-root',
    rootId: 'r-bravo',
  });
});

test('a root the run cannot use names no folder', () => {
  const write = byId(tools(), NATIVE_TOOL_ID.writeWorkspaceFile);
  expect(write.approvalTarget?.({ content: 'x', path: 'notes.md', root: 'charlie' })).toBe(
    undefined
  );
});

test('a tool that writes no workspace file has no approval target', () => {
  expect(byId(tools(), NATIVE_TOOL_ID.manageTaskList).approvalTarget).toBeUndefined();
});
