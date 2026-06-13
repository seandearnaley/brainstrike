import { expect, test } from '@playwright/test';
import { bootstrapFileExplorer } from './utils/file-explorer-setup';
import { getFileTree } from './utils/file-tree-locators';
import type { FileTree } from './utils/mock-fs';

/**
 * Forest identity invariant (forest-workspace hardening spec, Phase 3a).
 *
 * The file explorer must render EXACTLY ONE "File tree" treegrid per active
 * root. A single logical root enters the reducer through multiple seams (the
 * inline-fixture inject via setRoot, the web adapter's addRoot, and the boot
 * restore) — the rootId-only forest identity (PR #1203) reconciles them to one
 * root. A regression in any of those seams (e.g. one minting a fresh rootId
 * instead of reusing the root's) appends a duplicate and renders the tree TWICE
 * — the #1200 "two treegrids" bug, which escaped unit tests AND review twice and
 * was caught only by Web E2E.
 *
 * This @web-smoke guard runs on EVERY PR so that class of regression fails fast
 * here, not only in the (historically fragile) nightly full-regression lane.
 *
 * Coverage note: this asserts the single-root count (one root → one tree). The
 * two-granted-roots / same-named-roots restore scenario (also Phase 3a) needs a
 * multi-root e2e fixture harness that does not exist yet; it is tracked as a
 * follow-up so this guard can ship now rather than wait on that harness.
 */
const tree: FileTree = {
  'index.ts': null,
  src: {
    'app.ts': null,
  },
};

test.describe('Forest treegrid-count invariant', { tag: ['@smoke', '@web-smoke'] }, () => {
  test('renders exactly one file tree for a single root (no duplicate)', async ({ page }) => {
    const explorer = await bootstrapFileExplorer(page, { tree });

    // selectRoot() awaits expect(fileTree).toBeVisible(), which itself throws a
    // strict-mode violation on a duplicated tree; the explicit count below names
    // the invariant so a regression reads as a treegrid-count failure.
    await explorer.selectRoot();

    await expect(getFileTree(page)).toHaveCount(1);
  });
});
