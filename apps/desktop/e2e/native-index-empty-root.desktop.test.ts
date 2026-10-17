import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { type SeededRoot, seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  type NativeIndexSummary,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * With semantic search on, an empty workspace root (a new project folder, or
 * one whose only files are empty) must not block the native Workspace Index
 * (BST-2053). Its scan completes with no chunks to embed and its coverage
 * counts as complete.
 */

const SOURCE_FILES = 3;

let workspaceDir = '';

test.beforeAll(() => {
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-empty-root-'));
  const source = path.join(workspaceDir, 'source');
  mkdirSync(source);
  mkdirSync(path.join(workspaceDir, 'empty'));
  mkdirSync(path.join(workspaceDir, 'only-empty-file'));
  writeFileSync(path.join(workspaceDir, 'only-empty-file', '__init__.py'), '');
  for (let index = 0; index < SOURCE_FILES; index += 1) {
    writeFileSync(
      path.join(source, `module-${index}.ts`),
      `export function total${index}(values: readonly number[]): number {\n  let total = 0;\n  for (const value of values) {\n    total += value * ${index + 1};\n  }\n  return total;\n}\n`
    );
  }
});

test.afterAll(() => {
  rmSync(workspaceDir, { force: true, recursive: true });
});

/** Seeds the roots paused, chooses BGE Small on WASM, resumes, and polls the native summary. */
async function indexRoots(
  page: Page,
  roots: readonly SeededRoot[],
  expected: Record<string, unknown>
): Promise<void> {
  await seedPausedWorkspace(page, roots, 'wasm', 'empty-root-seeded');
  await configureNativeIndex(page, 'wasm');
  await waitForReadyIndex(page, 300_000);
  const resume = await openResumeControl(page);
  await resume.click();
  await closeIndexingPopover(page);
  await expect
    .poll(
      async (): Promise<NativeIndexSummary> => {
        const summary = await readNativeIndexSummary(page);
        const sorted = [...summary.roots].sort((left, right) =>
          left.rootId.localeCompare(right.rootId)
        );
        return { ...summary, roots: sorted };
      },
      { timeout: 180_000 }
    )
    .toMatchObject(expected);
  await expect(page.getByTestId('indexing-status-trigger')).not.toContainText('Blocked');
}

test.describe('Native Workspace Index with an empty root', () => {
  for (const [folder, indexedFiles] of [
    ['empty', 0],
    ['only-empty-file', 1],
  ] as const) {
    test(`a ${folder} root completes its semantic scan`, async ({ window: page }) => {
      test.setTimeout(6 * 60 * 1000);
      const rootId = `empty-root-e2e-${folder}`;
      await indexRoots(page, [{ path: path.join(workspaceDir, folder), rootId }], {
        chunkCount: 0,
        missingVectors: 0,
        roots: [{ chunks: 0, indexedFiles, rootId, scanComplete: true, vectors: 0 }],
        status: 'ready',
        vectorCoverageComplete: true,
      });
    });
  }

  test.fixme('an empty root beside a real one does not block semantic indexing', {
    annotation: { description: 'BST-2055', type: 'quarantine' },
  }, async ({ window: page }) => {
    test.setTimeout(8 * 60 * 1000);
    await indexRoots(
      page,
      [
        { path: path.join(workspaceDir, 'source'), rootId: 'empty-root-e2e-source' },
        { path: path.join(workspaceDir, 'empty'), rootId: 'empty-root-e2e-empty' },
      ],
      {
        missingVectors: 0,
        roots: [
          { indexedFiles: 0, rootId: 'empty-root-e2e-empty', scanComplete: true },
          { indexedFiles: SOURCE_FILES, rootId: 'empty-root-e2e-source', scanComplete: true },
        ],
        status: 'ready',
        vectorCoverageComplete: true,
      }
    );
    const hits = await page.evaluate(async () => {
      const capability = (
        globalThis as typeof globalThis & {
          readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
        }
      ).__brainstrikeTestHooks__?.indexSearch;
      const status = await capability?.status();
      if (!(capability && status?.kind === 'ready')) {
        throw new Error('The native index is not ready to search.');
      }
      const result = await capability.search({
        limit: 10,
        mode: 'bm25',
        rootIds: status.authorizedRootIds,
        text: 'total',
      });
      return result.hits.map((hit) => hit.relativePath);
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});
