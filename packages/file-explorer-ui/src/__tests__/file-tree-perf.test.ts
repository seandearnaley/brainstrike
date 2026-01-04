/**
 * Performance tests for FileTree component (BST-145 / BST-149)
 *
 * Tests the flattenTree operation against performance budgets.
 * Uses large tree fixtures to validate O(n) scaling behavior.
 *
 * ## Baseline Numbers (recorded 2026-01-04 on M1 Mac)
 *
 * | Preset    | Nodes  | flattenTree Time | Budget        |
 * |-----------|--------|------------------|---------------|
 * | small     | 90     | 0.04ms           | 50ms (PASS)   |
 * | medium    | 726    | 0.04ms           | 100ms (PASS)  |
 * | large     | 7029   | 0.41ms           | 250ms (PASS)  |
 * | repoScale | 27342  | 1.01ms           | 500ms (PASS)  |
 * | mega      | 83979  | 16ms             | 1000ms (PASS) |
 *
 * Scaling: ~0.01-0.02 μs/node (O(n) linear)
 *
 * The FLATTEN_TREE budget is 50ms. Tests verify:
 * - Small trees complete within 1x budget
 * - Medium trees complete within 2x budget
 * - Large trees complete within 5x budget
 * - RepoScale trees complete within 10x budget
 * - Mega trees complete within 20x budget (BST-149)
 */

import { flattenTreeForCount, generateLargeTree, largeTreePresets } from '@brainstrike/test-utils';
import { PERF_BUDGETS } from '@brainstrike/utils/perf-timing';
import { describe, expect, it } from 'vitest';

/**
 * Flattens a tree (mirrors FileTree.flattenTree logic)
 * Used to measure performance outside React context.
 */
type TreeNode = { path: string; type: string; children?: TreeNode[]; isVisible?: boolean };

function flattenTree(
  nodes: TreeNode[],
  expandedPaths: Set<string>,
  depth = 0,
  acc: { node: TreeNode; depth: number }[] = []
): { node: TreeNode; depth: number }[] {
  for (const n of nodes) {
    acc.push({ node: n, depth });
    if (n.type === 'directory' && expandedPaths.has(n.path) && n.children) {
      flattenTree(
        n.children.filter((c) => c.isVisible !== false),
        expandedPaths,
        depth + 1,
        acc
      );
    }
  }
  return acc;
}

describe('FileTree Performance (BST-145)', () => {
  describe('flattenTree budget compliance', () => {
    it('should flatten small tree (~100 nodes) within FLATTEN_TREE budget', () => {
      const { tree, nodeCount } = generateLargeTree(largeTreePresets.small);
      const allNodes = flattenTreeForCount(tree);

      // Expand all directories
      const expandedPaths = new Set<string>(
        allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
      );

      const start = performance.now();
      const flattened = flattenTree(tree, expandedPaths);
      const durationMs = performance.now() - start;

      // Log for baseline recording
      console.log(`[PERF] flattenTree small: ${durationMs.toFixed(2)}ms for ${nodeCount} nodes`);

      expect(durationMs).toBeLessThan(PERF_BUDGETS.flattenTree);
      expect(flattened.length).toBeGreaterThan(0);
    });

    it('should flatten medium tree (~1000 nodes) within 2x FLATTEN_TREE budget', () => {
      const { tree, nodeCount } = generateLargeTree(largeTreePresets.medium);
      const allNodes = flattenTreeForCount(tree);

      const expandedPaths = new Set<string>(
        allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
      );

      const start = performance.now();
      const flattened = flattenTree(tree, expandedPaths);
      const durationMs = performance.now() - start;

      console.log(`[PERF] flattenTree medium: ${durationMs.toFixed(2)}ms for ${nodeCount} nodes`);

      // Allow 2x budget for medium trees
      expect(durationMs).toBeLessThan(PERF_BUDGETS.flattenTree * 2);
      expect(flattened.length).toBeGreaterThan(0);
    });

    it('should flatten large tree (~5000 nodes) within 5x FLATTEN_TREE budget', () => {
      const { tree, nodeCount } = generateLargeTree(largeTreePresets.large);
      const allNodes = flattenTreeForCount(tree);

      const expandedPaths = new Set<string>(
        allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
      );

      const start = performance.now();
      const flattened = flattenTree(tree, expandedPaths);
      const durationMs = performance.now() - start;

      console.log(`[PERF] flattenTree large: ${durationMs.toFixed(2)}ms for ${nodeCount} nodes`);

      // Allow 5x budget for large trees (linear scaling)
      expect(durationMs).toBeLessThan(PERF_BUDGETS.flattenTree * 5);
      expect(flattened.length).toBeGreaterThan(0);
    });

    it('should flatten repoScale tree (~10000 nodes) within 10x FLATTEN_TREE budget', () => {
      const { tree, nodeCount } = generateLargeTree(largeTreePresets.repoScale);
      const allNodes = flattenTreeForCount(tree);

      const expandedPaths = new Set<string>(
        allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
      );

      const start = performance.now();
      const flattened = flattenTree(tree, expandedPaths);
      const durationMs = performance.now() - start;

      console.log(
        `[PERF] flattenTree repoScale: ${durationMs.toFixed(2)}ms for ${nodeCount} nodes`
      );

      // Allow 10x budget for repoScale trees
      expect(durationMs).toBeLessThan(PERF_BUDGETS.flattenTree * 10);
      expect(flattened.length).toBeGreaterThan(0);
    });

    it('should flatten mega tree (~84000 nodes) within 20x FLATTEN_TREE budget (BST-149)', () => {
      const { tree, nodeCount } = generateLargeTree(largeTreePresets.mega);
      const allNodes = flattenTreeForCount(tree);

      const expandedPaths = new Set<string>(
        allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
      );

      const start = performance.now();
      const flattened = flattenTree(tree, expandedPaths);
      const durationMs = performance.now() - start;

      console.log(`[PERF] flattenTree mega: ${durationMs.toFixed(2)}ms for ${nodeCount} nodes`);

      // Allow 20x budget for mega trees (linear scaling at ~0.02μs/node)
      expect(durationMs).toBeLessThan(PERF_BUDGETS.flattenTree * 20);
      expect(flattened.length).toBeGreaterThan(0);
      // Verify we actually have 80K+ nodes
      expect(nodeCount).toBeGreaterThan(80_000);
    });
  });

  describe('tree generation validation', () => {
    it('should generate trees with reasonable node counts', () => {
      for (const [name, config] of Object.entries(largeTreePresets)) {
        const { tree, nodeCount } = generateLargeTree(config);
        const allNodes = flattenTreeForCount(tree);

        // Generator should produce at least some nodes and match internal count
        expect(allNodes.length).toBeGreaterThan(10);
        expect(allNodes.length).toBe(nodeCount);

        console.log(`[PERF] ${name} preset: target=${config.targetNodeCount}, actual=${nodeCount}`);
      }
    });
  });

  describe('scaling behavior', () => {
    // Skip in CI - this test is for local baseline recording only.
    // CI runners have variable CPU performance and timer resolution issues
    // that cause false failures. The individual budget tests above still
    // validate that performance is acceptable.
    it.skipIf(Boolean(process.env['CI']))(
      'should demonstrate O(n) scaling for flatten operation',
      () => {
        const results: { nodes: number; timeMs: number }[] = [];

        // Test with increasing tree sizes
        const configs = [
          { targetNodeCount: 100, maxDepth: 3, filesPerDir: 3, subdirsPerDir: 2 },
          { targetNodeCount: 500, maxDepth: 4, filesPerDir: 4, subdirsPerDir: 3 },
          { targetNodeCount: 1000, maxDepth: 5, filesPerDir: 5, subdirsPerDir: 3 },
        ];

        for (const config of configs) {
          const { tree } = generateLargeTree(config);
          const allNodes = flattenTreeForCount(tree);
          const expandedPaths = new Set<string>(
            allNodes.filter((n) => n.type === 'directory').map((n) => n.path)
          );

          // Warm up JIT
          flattenTree(tree, expandedPaths);
          flattenTree(tree, expandedPaths);

          // Measure
          const start = performance.now();
          flattenTree(tree, expandedPaths);
          const durationMs = performance.now() - start;

          results.push({ nodes: allNodes.length, timeMs: durationMs });
        }

        // Log results for baseline recording
        // biome-ignore lint/suspicious/noConsole: Intentional perf baseline logging
        console.log('[PERF] Scaling results:');
        for (const r of results) {
          // biome-ignore lint/suspicious/noConsole: Intentional perf baseline logging
          console.log(
            `  ${r.nodes} nodes: ${r.timeMs.toFixed(2)}ms (${((r.timeMs / r.nodes) * 1000).toFixed(2)}μs/node)`
          );
        }

        // Verify scaling is roughly linear (time/node should be relatively constant)
        const timePerNode = results.map((r) => r.timeMs / r.nodes);
        const maxRatio = Math.max(...timePerNode) / Math.min(...timePerNode);

        // Allow up to 5x variance in per-node time (accounts for overhead in small trees)
        expect(maxRatio).toBeLessThan(5);
      }
    );
  });
});
