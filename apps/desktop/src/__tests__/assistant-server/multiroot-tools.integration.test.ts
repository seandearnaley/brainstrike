/**
 * Multi-root assistant tools — REAL end-to-end integration.
 *
 * Unlike the per-tool unit specs, this harness drives the actual tool execute()
 * functions against REAL on-disk workspace roots, simulating the assistant calling its tools in a
 * two-root workspace where both roots share a relative path (README.md). It is
 * the "put the tools through their paces" pass for the multi-root work.
 */

import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { grepSearchExecutor } from '../../assistant-server/native-tool-executors-grep';
import { nativeGrepFixture } from './_c1-a-helpers';
import { buildHostNativeTools } from './_host-native-tools';
import { requireToolExecute } from './_tool-test-helpers';

const ROOT_A = { displayName: 'ProjectA', rootId: 'root-a' };
const ROOT_B = { displayName: 'ProjectB', rootId: 'root-b' };
let rootAPath: string;
let rootBPath: string;

function twoRootRuntime(): RuntimeData {
  return {
    workspaceIndexEmbeddingSetId: 'set-1',
    workspaceIndexingEnabled: true,
    workspaceIndexStatusState: 'idle',
    workspaceRoots: [
      { displayName: ROOT_A.displayName, path: rootAPath, rootId: ROOT_A.rootId },
      { displayName: ROOT_B.displayName, path: rootBPath, rootId: ROOT_B.rootId },
    ],
  } as unknown as RuntimeData;
}

/**
 * The host's grep: the live ripgrep pass over both roots plus Main's native
 * grep index (`nativeGrepIndex`) serving the indexed README chunks.
 */
function hostGrepTools() {
  // The native index authorizes the runtime's workspace-index collection and both roots.
  const grep = nativeGrepFixture({
    authorizedCollectionIds: ['set-1'],
    authorizedRootIds: [ROOT_A.rootId, ROOT_B.rootId],
  });
  grep.serve([
    {
      content: 'const sharedMarker = "alpha";',
      path: 'README.md',
      root_id: ROOT_A.rootId,
      start_line: 3,
    },
    {
      content: 'const sharedMarker = "beta";',
      path: 'README.md',
      root_id: ROOT_B.rootId,
      start_line: 3,
    },
  ]);
  return buildHostNativeTools(twoRootRuntime(), {
    executors: { [NATIVE_TOOL_ID.grepSearch]: grepSearchExecutor(grep.index) },
    ids: [NATIVE_TOOL_ID.grepSearch],
  });
}

describe('multi-root assistant tools (real roots)', () => {
  beforeEach(() => {
    resetToolCallLoopGuards();
  });

  beforeAll(async () => {
    // 1. Real on-disk roots that share a relative path with distinct content.
    rootAPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-mr-a-'));
    rootBPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bs-mr-b-'));
    await fsPromises.writeFile(
      path.join(rootAPath, 'README.md'),
      '# Project A\nexport function fromA() { return 1; }\nconst sharedMarker = "alpha";\n',
      'utf8'
    );
    await fsPromises.writeFile(
      path.join(rootBPath, 'README.md'),
      '# Project B\nexport function fromB() { return 2; }\nconst sharedMarker = "beta";\n',
      'utf8'
    );
  }, 60_000);

  afterAll(async () => {
    await fsPromises.rm(rootAPath, { force: true, recursive: true });
    await fsPromises.rm(rootBPath, { force: true, recursive: true });
  });

  it('Task: "what folders are open?" — listWorkspaceContext lists both roots', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime(), {
        // The listing reports Main's native index status beside the open roots.
        request: async (method) => {
          if (method !== 'desktop-read/index/status') {
            throw new Error(`Unexpected Main request ${method}`);
          }
          return { kind: 'unavailable', reason: 'This case indexes nothing.' };
        },
      }),
      'brainstrike.listWorkspaceContext'
    );
    const result = await executeTool({ context: {} });
    expect(result.workspaceRoots).toEqual([
      { displayName: ROOT_A.displayName, path: rootAPath, rootId: ROOT_A.rootId },
      { displayName: ROOT_B.displayName, path: rootBPath, rootId: ROOT_B.rootId },
    ]);
  });

  it('Task: grep a shared term — content matches are labelled and same-path roots stay distinct', async () => {
    const executeTool = requireToolExecute(hostGrepTools(), 'brainstrike.grepSearch');
    const result = await executeTool({
      context: { outputMode: 'content', pattern: 'sharedMarker' },
    });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(2);
    const labelled = result.matches
      .map(
        (match: { line: number; path: string; rootName: string }) =>
          `${match.rootName}/${match.path}:${match.line}`
      )
      .sort();
    expect(labelled).toEqual(['ProjectA/README.md:3', 'ProjectB/README.md:3']);
  });

  it('Task: grep scoped to one folder via `root` — only that root matches', async () => {
    const executeTool = requireToolExecute(hostGrepTools(), 'brainstrike.grepSearch');
    const result = await executeTool({
      context: { outputMode: 'content', pattern: 'sharedMarker', root: 'ProjectB' },
    });
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode');
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.rootName).toBe('ProjectB');
    expect(result.matches[0]?.lineText).toContain('beta');
  });

  it('Task: read README.md with no root (ambiguous) — errors and lists the open folders', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime()),
      'brainstrike.readWorkspaceFile'
    );
    await expect(executeTool({ context: { path: '/README.md' } })).rejects.toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
  });

  it("Task: read README.md qualified by root — returns the correct root's file", async () => {
    const tools = buildHostNativeTools(twoRootRuntime());
    const executeTool = requireToolExecute(tools, 'brainstrike.readWorkspaceFile');
    const a = await executeTool({
      context: { path: '/README.md', root: 'ProjectA' },
    });
    expect(a.rootName).toBe('ProjectA');
    expect(a.content).toContain('Project A');
    expect(a.content).not.toContain('Project B');

    const b = await executeTool({
      context: { path: '/README.md', root: ROOT_B.rootId },
    });
    expect(b.rootName).toBe('ProjectB');
    expect(b.content).toContain('Project B');
  });

  it('Task: list a directory in a chosen root — labelled and root-scoped', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime()),
      'brainstrike.readWorkspaceDirectory'
    );
    const result = await executeTool({ context: { path: '/', root: 'ProjectA' } });
    expect(result.rootName).toBe('ProjectA');
    expect(result.entries.some((e: { path: string }) => e.path === '/README.md')).toBe(true);
  });

  it('Task: find a symbol in a chosen root — labelled', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime()),
      'brainstrike.findWorkspaceSymbol'
    );
    const result = await executeTool({
      context: { path: '/README.md', query: 'fromB', root: 'ProjectB' },
    });
    expect(result.rootName).toBe('ProjectB');
    expect(result.totalMatches).toBeGreaterThan(0);
  });

  it('Task: read curated context in a chosen root (explicit filePaths) — labelled by root', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime()),
      'brainstrike.readWorkspaceContext'
    );
    const result = await executeTool({
      context: { filePaths: ['/README.md'], root: 'ProjectB' },
    });
    expect(result.rootName).toBe('ProjectB');
    expect(result.files[0]?.content).toContain('Project B');
  });

  it('Task: read curated context without root (ambiguous) — errors and lists the open folders', async () => {
    const executeTool = requireToolExecute(
      buildHostNativeTools(twoRootRuntime()),
      'brainstrike.readWorkspaceContext'
    );
    await expect(executeTool({ context: { filePaths: ['/README.md'] } })).rejects.toThrow(
      /multiple folders.*ProjectA.*ProjectB/is
    );
  });
});
