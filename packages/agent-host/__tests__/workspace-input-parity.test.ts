import { NATIVE_TOOLS } from '@brainstrike/assistant-contract';
import {
  normalizeProviderNulls,
  validateToolInputValue,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { workspaceZodTwins } from './fixtures/workspace-zod-twins.js';

const cases: ReadonlyArray<{ readonly name: string; readonly input: unknown }> = [
  {
    input: { action: 'create', canvasId: 'extra', html: '', title: '🙂'.repeat(500) },
    name: 'manageCanvas',
  },
  { input: { action: 'create', html: '', title: '🙂'.repeat(501) }, name: 'manageCanvas' },
  { input: { action: 'update', canvasId: 'c', oldString: 'old' }, name: 'manageCanvas' },
  { input: { action: 'list', title: 'extra' }, name: 'manageCanvas' },
  { input: { action: 'list', unknown: 1 }, name: 'manageCanvas' },
  { input: { maxChars: null, path: 'a.ts' }, name: 'readWorkspaceFile' },
  { input: { cursor: 'rfh_abcdefghijklmnopqrstuv', path: null }, name: 'readWorkspaceFile' },
  {
    input: { cursor: 'rfh_abcdefghijklmnopqrstuv', path: 'a.ts', root: 'root' },
    name: 'readWorkspaceFile',
  },
  { input: {}, name: 'readWorkspaceFile' },
  { input: { maxChars: 50_001, path: 'a.ts' }, name: 'readWorkspaceFile' },
  { input: { content: '', path: 'a.ts', root: null }, name: 'writeWorkspaceFile' },
  { input: { content: null, path: 'a.ts' }, name: 'writeWorkspaceFile' },
  { input: { newStr: '', oldStr: 'old', path: 'a.ts' }, name: 'stringReplaceWorkspaceFile' },
  { input: { newStr: 'new', oldStr: '', path: 'a.ts' }, name: 'stringReplaceWorkspaceFile' },
  { input: { path: 'a.ts', root: null }, name: 'deleteWorkspaceFile' },
  { input: { fromPath: 'a.ts', toPath: 'b.ts' }, name: 'renameWorkspaceFile' },
  { input: { depth: 5, maxEntries: 500, offset: 5000 }, name: 'readWorkspaceDirectory' },
  { input: { depth: 6 }, name: 'readWorkspaceDirectory' },
  {
    input: { contextLines: 10, maxMatches: 20, path: 'a.ts', query: 'q' },
    name: 'findWorkspaceSymbol',
  },
  {
    input: { maxMatches: Number.POSITIVE_INFINITY, path: 'a.ts', query: 'q' },
    name: 'findWorkspaceSymbol',
  },
  { input: {}, name: 'listWorkspaceContext' },
  { input: [], name: 'listWorkspaceContext' },
  { input: 1, name: 'listWorkspaceContext' },
  { input: { unknown: 1 }, name: 'listWorkspaceContext' },
  { input: { filePaths: ['a.ts'], maxFiles: null }, name: 'readWorkspaceContext' },
  { input: { filePaths: [''] }, name: 'readWorkspaceContext' },
  { input: { filePaths: [] }, name: 'readWorkspaceContext' },
  { input: { name: 's', rider: 'strip' }, name: 'skill' },
  { input: { path: 'f', rider: 'strip', skillName: 's', startLine: -0.5 }, name: 'skill_read' },
  { input: { query: '', rider: 'strip', skillNames: ['s'], topK: 0.5 }, name: 'skill_search' },
  { input: { query: 's', topK: null }, name: 'skill_search' },
];

test.each(cases)(
  '$name keeps preconversion acceptance and decoded values ($#)',
  ({ name, input }) => {
    const id = name.startsWith('skill') ? name : `brainstrike.${name}`;
    const tool = NATIVE_TOOLS.find((entry) => entry.id === id);
    const twin = workspaceZodTwins.find(([toolId]) => toolId === id)?.[1];
    if (!(tool && twin)) {
      throw new Error(`Missing production schema or oracle: ${id}`);
    }
    const json = z.toJSONSchema(twin, { io: 'input', unrepresentable: 'any' });
    const original = twin.safeParse(
      tool.kind === 'skill' ? input : normalizeProviderNulls(input, json)
    );
    const actual = validateToolInputValue(tool.inputSchema, input);
    expect(actual.success).toBe(original.success);
    if (actual.success && original.success) {
      expect(actual.value).toEqual(original.data);
    }
    if (!(actual.success || original.success)) {
      const originalPaths = original.error.issues.map((issue) => issue.path);
      const actualPaths = actual.issues.map((issue) => issue.path);
      if (typeof input === 'object' && input !== null && 'unknown' in input) {
        // Zod reports a strict-object error at the envelope; Effect names the excess key.
        expect(originalPaths).toEqual([[]]);
        expect(actualPaths).toEqual([['unknown']]);
        return;
      }
      // A bound may produce more than one diagnostic; field identity is the contract.
      expect(new Set(actualPaths.map((path) => JSON.stringify(path)))).toEqual(
        new Set(originalPaths.map((path) => JSON.stringify(path)))
      );
    }
  }
);
