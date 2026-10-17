import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * With semantic search on, an empty workspace root (a new project folder) must
 * not block the native Workspace Index for the workspace's other roots
 * (BST-2053). Today the empty root's scan fails canonical VECTOR completion,
 * and the failure blocks the whole index: the other root never indexes.
 */

const SOURCE_FILES = 3;

let workspaceDir = '';

test.beforeAll(() => {
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-empty-root-'));
  const source = path.join(workspaceDir, 'source');
  mkdirSync(source);
  mkdirSync(path.join(workspaceDir, 'empty'));
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

test.describe('Native Workspace Index with an empty root', () => {
  test.fixme('an empty root beside a real one does not block semantic indexing', {
    annotation: { description: 'BST-2053', type: 'quarantine' },
  }, async ({ window: page }) => {
    test.setTimeout(8 * 60 * 1000);
    await seedPausedWorkspace(
      page,
      [
        { path: path.join(workspaceDir, 'source'), rootId: 'empty-root-e2e-source' },
        { path: path.join(workspaceDir, 'empty'), rootId: 'empty-root-e2e-empty' },
      ],
      'wasm',
      'empty-root-seeded'
    );
    await configureNativeIndex(page, 'wasm');
    await waitForReadyIndex(page, 300_000);
    const resume = await openResumeControl(page);
    await resume.click();
    await closeIndexingPopover(page);

    await expect
      .poll(
        async () => {
          const summary = await readNativeIndexSummary(page);
          const roots = [...summary.roots].sort((left, right) =>
            left.rootId.localeCompare(right.rootId)
          );
          return { ...summary, roots };
        },
        { timeout: 180_000 }
      )
      .toMatchObject({
        missingVectors: 0,
        roots: [
          { indexedFiles: 0, rootId: 'empty-root-e2e-empty', scanComplete: true },
          { indexedFiles: SOURCE_FILES, rootId: 'empty-root-e2e-source', scanComplete: true },
        ],
        status: 'ready',
      });
    await expect(page.getByTestId('indexing-status-trigger')).not.toContainText('Blocked');
  });
});
