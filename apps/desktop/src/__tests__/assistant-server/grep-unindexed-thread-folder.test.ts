// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import { afterEach, expect, test } from 'vitest';
import { nativeGrepIndex } from '../../agent-host-platform/native-grep-index';
import { runGrepSearchWith } from '../../assistant-server/grep-search-core';
import { fixture } from '../native-scoped-search-fixture';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bs-grep-unindexed-'));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await writeFile(path.join(dir, relative), content);
  }
  return dir;
}

/**
 * A worktree-mode thread works in a managed worktree, which the index leaves
 * out until it is opted in (BST-1988), next to the indexed repository. Main's
 * index refuses a folder it does not authorize, so a thread grep that asked it
 * for every thread folder failed whole (2026-10-20 debug pack). The index
 * answers for the folders it covers; the live pass reads the worktree.
 */
test('a thread grep reads its unindexed worktree folder live instead of failing', async () => {
  const f = fixture();
  f.replaceAuthority({
    bindings: [],
    collectionId: null,
    generation: 1,
    profile: null,
    queryPlan: undefined,
    readiness: [
      {
        generation: 1,
        mutationRevision: 0,
        scanComplete: true,
        scope: { kind: 'workspace', rootId: 'indexed' },
      },
    ],
    rootIds: ['indexed'],
  });
  const indexedRows = f.grep.getMockImplementation();
  if (!indexedRows) {
    throw new Error('The scoped search fixture has no grep reader.');
  }
  f.grep.mockImplementation(async () => ({ ...(await indexedRows()), matchedChunks: 0, rows: [] }));
  const runtimeData: RuntimeData = {
    boundWorkspaceRootId: 'worktree',
    workspaceRoots: [
      {
        displayName: 'repository',
        path: await folder({ 'src/clean.ts': 'nothing here\n' }),
        rootId: 'indexed',
      },
      {
        displayName: 'gentle-raven',
        path: await folder({ 'src/bug.ts': 'const needle = 1;\n' }),
        rootId: 'worktree',
      },
    ],
  };

  const result = await runGrepSearchWith(
    { pattern: 'needle' },
    runtimeData,
    nativeGrepIndex(f.capability)
  );

  expect(result).toMatchObject({
    files: [{ path: 'src/bug.ts', rootId: 'worktree', source: 'live' }],
    totalMatches: 1,
  });
  // The index still answered for the folder it covers.
  expect(f.grep).toHaveBeenCalled();
});
