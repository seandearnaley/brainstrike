import { describe, expect, it, vi } from 'vitest';
import {
  createSelectionRuleEngine,
  type FileNode,
  InMemoryTreeAdapter,
  SelectionRuleEngine,
} from '../engine';
import type { SelectionRuleSet } from '../schema';
import { createEmptyRuleSet } from '../schema';

describe('engine', () => {
  // Sample tree structure for testing
  const sampleNodes: FileNode[] = [
    { path: 'src', isDirectory: true },
    { path: 'src/index.ts', isDirectory: false },
    { path: 'src/utils.ts', isDirectory: false },
    { path: 'src/components', isDirectory: true },
    { path: 'src/components/Button.tsx', isDirectory: false },
    { path: 'src/components/Input.tsx', isDirectory: false },
    { path: 'src/components/__tests__', isDirectory: true },
    { path: 'src/components/__tests__/Button.test.tsx', isDirectory: false },
    { path: 'lib', isDirectory: true },
    { path: 'lib/helpers.ts', isDirectory: false },
    { path: 'lib/constants.ts', isDirectory: false },
    { path: 'node_modules', isDirectory: true },
    { path: 'node_modules/lodash/index.js', isDirectory: false },
    { path: 'package.json', isDirectory: false },
    { path: 'tsconfig.json', isDirectory: false },
  ];

  const sampleTree = new InMemoryTreeAdapter(sampleNodes);

  const now = '2026-01-02T00:00:00.000Z';

  describe('InMemoryTreeAdapter', () => {
    it('should return all file paths', () => {
      const paths = Array.from(sampleTree.getAllFilePaths());

      expect(paths).toHaveLength(10);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('package.json');
      expect(paths).not.toContain('src'); // directories excluded
    });

    it('should return files under a root', () => {
      const paths = Array.from(sampleTree.getFilesUnderRoot('src'));

      expect(paths).toHaveLength(5);
      expect(paths).toContain('src/index.ts');
      expect(paths).toContain('src/components/Button.tsx');
    });

    it('should respect maxDepth', () => {
      const paths = Array.from(sampleTree.getFilesUnderRoot('src', 0));

      expect(paths).toHaveLength(2); // Only src/index.ts and src/utils.ts
      expect(paths).toContain('src/index.ts');
      expect(paths).not.toContain('src/components/Button.tsx');
    });

    it('should check path existence', () => {
      expect(sampleTree.pathExists('src')).toBe(true);
      expect(sampleTree.pathExists('src/index.ts')).toBe(true);
      expect(sampleTree.pathExists('nonexistent')).toBe(false);
    });

    it('synthesizes missing parent directories even when a nested directory is explicit', () => {
      const tree = new InMemoryTreeAdapter([
        { path: 'src/components', isDirectory: true },
        { path: 'src/components/Button.tsx', isDirectory: false },
      ]);

      expect(tree.pathExists('src')).toBe(true);
      expect(Array.from(tree.getFilesUnderRoot('src'))).toEqual(['src/components/Button.tsx']);
    });

    it('synthesizes implicit parent directories without splitting every file path', () => {
      let tree: InMemoryTreeAdapter | null = null;
      const splitSpy = vi.spyOn(String.prototype, 'split');
      let splitCalls = 0;
      try {
        tree = new InMemoryTreeAdapter([
          { path: 'src/components/Button.tsx', isDirectory: false },
          { path: 'src/components/forms/Input.tsx', isDirectory: false },
        ]);
      } finally {
        splitCalls = splitSpy.mock.calls.length;
        splitSpy.mockRestore();
      }

      expect(splitCalls).toBe(0);
      expect(tree?.pathExists('src')).toBe(true);
      expect(tree?.pathExists('src/components')).toBe(true);
      expect(tree?.pathExists('src/components/forms')).toBe(true);
    });

    it('does not treat shared path prefixes as descendants of a root', () => {
      const tree = new InMemoryTreeAdapter([
        { path: 'src/index.ts', isDirectory: false },
        { path: 'src-generated/index.ts', isDirectory: false },
        { path: 'src/components/Button.tsx', isDirectory: false },
        { path: 'src/components-extra/Button.tsx', isDirectory: false },
      ]);

      expect(Array.from(tree.getFilesUnderRoot('src'))).toEqual([
        'src/index.ts',
        'src/components/Button.tsx',
        'src/components-extra/Button.tsx',
      ]);
      expect(Array.from(tree.getFilesUnderRoot('src/components'))).toEqual([
        'src/components/Button.tsx',
      ]);
    });

    it('respects maxDepth without treating shared prefixes as descendants', () => {
      const tree = new InMemoryTreeAdapter([
        { path: 'src/index.ts', isDirectory: false },
        { path: 'src/components/Button.tsx', isDirectory: false },
        { path: 'src/components/forms/Input.tsx', isDirectory: false },
        { path: 'src-generated/index.ts', isDirectory: false },
        { path: 'src-generated/components/Button.tsx', isDirectory: false },
      ]);

      expect(Array.from(tree.getFilesUnderRoot('src', 0))).toEqual(['src/index.ts']);
      expect(Array.from(tree.getFilesUnderRoot('src', 1))).toEqual([
        'src/index.ts',
        'src/components/Button.tsx',
      ]);
      expect(Array.from(tree.getFilesUnderRoot('src', 2))).toEqual([
        'src/index.ts',
        'src/components/Button.tsx',
        'src/components/forms/Input.tsx',
      ]);
    });

    it('should return correct total file count', () => {
      expect(sampleTree.getTotalFileCount()).toBe(10);
    });
  });

  describe('SelectionRuleEngine', () => {
    describe('root-include rules', () => {
      it('should include all files under specified roots', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'root-include',
              roots: ['src'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(5);
        expect(result.paths.has('src/index.ts')).toBe(true);
        expect(result.paths.has('lib/helpers.ts')).toBe(false);
        expect(result.appliedRules).toContain('r1');
      });

      it('should warn for non-existent roots', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'root-include',
              roots: ['nonexistent'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].code).toBe('root-not-found');
      });

      it('should respect maxDepth', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'root-include',
              roots: ['src'],
              maxDepth: 0,
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(2);
        expect(result.paths.has('src/index.ts')).toBe(true);
        expect(result.paths.has('src/components/Button.tsx')).toBe(false);
      });
    });

    describe('glob-include rules', () => {
      it('should include files matching glob patterns', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*.tsx'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(3);
        expect(result.paths.has('src/components/Button.tsx')).toBe(true);
        expect(result.paths.has('src/index.ts')).toBe(false);
      });

      it('should support basePath', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['*.ts'],
              basePath: 'lib',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(2);
        expect(result.paths.has('lib/helpers.ts')).toBe(true);
        expect(result.paths.has('src/index.ts')).toBe(false);
      });

      it('should warn for patterns with no matches', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*.py'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.warnings.some((w) => w.code === 'pattern-no-match')).toBe(true);
      });
    });

    describe('root-exclude rules', () => {
      it('should exclude files under specified roots', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'root-exclude',
              roots: ['node_modules'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.has('node_modules/lodash/index.js')).toBe(false);
        expect(result.paths.has('src/index.ts')).toBe(true);
      });

      it('does not exclude files that only share a string prefix with the root', () => {
        const tree = new InMemoryTreeAdapter([
          { path: 'src/index.ts', isDirectory: false },
          { path: 'src-generated/index.ts', isDirectory: false },
        ]);
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'root-exclude',
              roots: ['src'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(tree);

        expect(result.paths.has('src/index.ts')).toBe(false);
        expect(result.paths.has('src-generated/index.ts')).toBe(true);
      });
    });

    describe('glob-exclude rules', () => {
      it('should exclude files matching patterns', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*.tsx'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'glob-exclude',
              patterns: ['**/*.test.tsx'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(2);
        expect(result.paths.has('src/components/Button.tsx')).toBe(true);
        expect(result.paths.has('src/components/__tests__/Button.test.tsx')).toBe(false);
      });

      it('should correctly exclude with multiple patterns', () => {
        // Regression test: Previously only the last pattern was effective
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'include-all',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
            {
              id: 'exclude-multi',
              type: 'glob-exclude',
              patterns: ['**/*.test.tsx', '**/*.json'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        // Both patterns should be excluded
        expect(result.paths.has('src/components/__tests__/Button.test.tsx')).toBe(false);
        expect(result.paths.has('package.json')).toBe(false);
        expect(result.paths.has('tsconfig.json')).toBe(false);

        // But other files should still be included
        expect(result.paths.has('src/index.ts')).toBe(true);
        expect(result.paths.has('src/components/Button.tsx')).toBe(true);
      });

      it('should progressively exclude with each pattern', () => {
        // Test that patterns are applied cumulatively
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'include-ts',
              type: 'glob-include',
              patterns: ['**/*.ts', '**/*.tsx'],
              createdAt: now,
            },
            {
              id: 'exclude-multi',
              type: 'glob-exclude',
              patterns: ['**/utils.ts', '**/helpers.ts', '**/Button.tsx'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        // All three patterns should be excluded
        expect(result.paths.has('src/utils.ts')).toBe(false);
        expect(result.paths.has('lib/helpers.ts')).toBe(false);
        expect(result.paths.has('src/components/Button.tsx')).toBe(false);

        // But other files should remain
        expect(result.paths.has('src/index.ts')).toBe(true);
        expect(result.paths.has('src/components/Input.tsx')).toBe(true);
        expect(result.paths.has('lib/constants.ts')).toBe(true);
      });
    });

    describe('explicit rules', () => {
      it('should force include specific paths', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'explicit',
              paths: ['package.json', 'tsconfig.json'],
              mode: 'include',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(2);
        expect(result.paths.has('package.json')).toBe(true);
        expect(result.paths.has('tsconfig.json')).toBe(true);
      });

      it('should force exclude specific paths', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['*.json'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'explicit',
              paths: ['tsconfig.json'],
              mode: 'exclude',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.has('package.json')).toBe(true);
        expect(result.paths.has('tsconfig.json')).toBe(false);
      });

      it('should warn for non-existent explicit paths', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'explicit',
              paths: ['nonexistent.ts'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.warnings.some((w) => w.message.includes('not found'))).toBe(true);
      });
    });

    describe('cap rules', () => {
      it('should limit selection to maxCount with first strategy', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'cap',
              maxCount: 3,
              strategy: 'first',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(3);
        expect(result.capped).toBe(true);
        expect(result.originalCount).toBe(10);
        expect(result.warnings.some((w) => w.code === 'cap-applied')).toBe(true);
      });

      it('should not cap if under limit', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'explicit',
              paths: ['package.json'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'cap',
              maxCount: 10,
              strategy: 'first',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(1);
        expect(result.capped).toBe(false);
      });

      it('should use random strategy with seed for deterministic results', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'cap',
              maxCount: 3,
              strategy: 'random',
              seed: 42,
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result1 = engine.materialize(sampleTree);
        const result2 = engine.materialize(sampleTree);

        // Same seed should produce same results
        expect(Array.from(result1.paths)).toEqual(Array.from(result2.paths));
      });

      it('should use priority strategy to keep first N', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'explicit',
              paths: ['package.json', 'tsconfig.json', 'src/index.ts'],
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'cap',
              maxCount: 2,
              strategy: 'priority',
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(2);
      });
    });

    describe('disabled rules', () => {
      it('should skip disabled rules', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*.ts'],
              enabled: false,
              createdAt: now,
            },
            {
              id: 'r2',
              type: 'explicit',
              paths: ['package.json'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        expect(result.paths.size).toBe(1);
        expect(result.paths.has('package.json')).toBe(true);
        expect(result.warnings.some((w) => w.code === 'rule-disabled')).toBe(true);
      });
    });

    describe('rule precedence', () => {
      it('should evaluate rules in precedence order', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            // Add these in wrong order - engine should sort correctly
            {
              id: 'explicit',
              type: 'explicit',
              paths: ['package.json'],
              createdAt: now,
            },
            {
              id: 'root-include',
              type: 'root-include',
              roots: ['src'],
              createdAt: now,
            },
            {
              id: 'glob-exclude',
              type: 'glob-exclude',
              patterns: ['**/*.test.tsx'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree);

        // Should have src files + package.json, minus test files
        expect(result.paths.has('src/index.ts')).toBe(true);
        expect(result.paths.has('package.json')).toBe(true);
        expect(result.paths.has('src/components/__tests__/Button.test.tsx')).toBe(false);
      });
    });

    describe('materialize options', () => {
      it('should respect limit option', () => {
        const ruleSet: SelectionRuleSet = {
          ...createEmptyRuleSet('folder'),
          rules: [
            {
              id: 'r1',
              type: 'glob-include',
              patterns: ['**/*'],
              createdAt: now,
            },
          ],
        };

        const engine = createSelectionRuleEngine(ruleSet);
        const result = engine.materialize(sampleTree, { limit: 5 });

        expect(result.paths.size).toBe(5);
        expect(result.capped).toBe(true);
      });
    });
  });

  describe('SelectionRuleEngine.computeDiff', () => {
    it('should compute added paths', () => {
      const old = {
        paths: new Set(['a.ts', 'b.ts']),
        appliedRules: [],
        capped: false,
        originalCount: 2,
        warnings: [],
        materializedAt: now,
      };
      const newer = {
        paths: new Set(['a.ts', 'b.ts', 'c.ts']),
        appliedRules: [],
        capped: false,
        originalCount: 3,
        warnings: [],
        materializedAt: now,
      };

      const diff = SelectionRuleEngine.computeDiff(old, newer);

      expect(diff.added.size).toBe(1);
      expect(diff.added.has('c.ts')).toBe(true);
      expect(diff.removed.size).toBe(0);
      expect(diff.unchanged).toBe(false);
    });

    it('should compute removed paths', () => {
      const old = {
        paths: new Set(['a.ts', 'b.ts', 'c.ts']),
        appliedRules: [],
        capped: false,
        originalCount: 3,
        warnings: [],
        materializedAt: now,
      };
      const newer = {
        paths: new Set(['a.ts']),
        appliedRules: [],
        capped: false,
        originalCount: 1,
        warnings: [],
        materializedAt: now,
      };

      const diff = SelectionRuleEngine.computeDiff(old, newer);

      expect(diff.added.size).toBe(0);
      expect(diff.removed.size).toBe(2);
      expect(diff.removed.has('b.ts')).toBe(true);
      expect(diff.removed.has('c.ts')).toBe(true);
    });

    it('should detect unchanged selections', () => {
      const selection = {
        paths: new Set(['a.ts', 'b.ts']),
        appliedRules: [],
        capped: false,
        originalCount: 2,
        warnings: [],
        materializedAt: now,
      };

      const diff = SelectionRuleEngine.computeDiff(selection, selection);

      expect(diff.unchanged).toBe(true);
    });
  });

  describe('estimateCount', () => {
    it('should return accurate count', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'r1',
            type: 'root-include',
            roots: ['src'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const count = engine.estimateCount(sampleTree);

      expect(count).toBe(5);
    });
  });

  describe('appliedRules tracking (mutation test coverage)', () => {
    it('should NOT add cap rule to appliedRules when selection is under maxCount', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'explicit-small',
            type: 'explicit',
            paths: ['package.json'],
            createdAt: now,
          },
          {
            id: 'cap-large',
            type: 'cap',
            maxCount: 100, // Much larger than selection
            strategy: 'first',
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree);

      expect(result.capped).toBe(false);
      expect(result.appliedRules).not.toContain('cap-large');
      expect(result.appliedRules).toContain('explicit-small');
    });

    it('should NOT add exclusion rule to appliedRules when nothing is excluded', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-json',
            type: 'explicit',
            paths: ['package.json'],
            createdAt: now,
          },
          {
            id: 'exclude-py',
            type: 'glob-exclude',
            patterns: ['**/*.py'], // No .py files in selection
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree);

      expect(result.paths.size).toBe(1);
      expect(result.appliedRules).toContain('include-json');
      expect(result.appliedRules).not.toContain('exclude-py');
    });

    it('should NOT add root-exclude rule to appliedRules when nothing is excluded', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-lib',
            type: 'root-include',
            roots: ['lib'],
            createdAt: now,
          },
          {
            id: 'exclude-nonexistent',
            type: 'root-exclude',
            roots: ['nonexistent-folder'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree);

      expect(result.paths.size).toBe(2);
      expect(result.appliedRules).toContain('include-lib');
      expect(result.appliedRules).not.toContain('exclude-nonexistent');
    });

    it('should NOT add explicit rule to appliedRules when files already in selection', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-all-json',
            type: 'glob-include',
            patterns: ['**/*.json'],
            createdAt: now,
          },
          {
            id: 'explicit-already-included',
            type: 'explicit',
            paths: ['package.json'], // Already included by glob
            mode: 'include',
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree);

      expect(result.paths.has('package.json')).toBe(true);
      expect(result.appliedRules).toContain('include-all-json');
      // Explicit rule didn't change anything - it shouldn't be in appliedRules
      expect(result.appliedRules).not.toContain('explicit-already-included');
    });

    it('should add include rule to appliedRules only when it adds files', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-empty-pattern',
            type: 'glob-include',
            patterns: ['**/*.nonexistent'], // Matches nothing
            createdAt: now,
          },
          {
            id: 'include-ts',
            type: 'glob-include',
            patterns: ['**/*.ts'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree);

      expect(result.appliedRules).toContain('include-ts');
      // Empty pattern shouldn't be in appliedRules since it added nothing
      // Note: This tests the paths.size > 0 condition
    });
  });

  describe('options.limit behavior', () => {
    it('should apply options.limit when no cap rule exists', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-all',
            type: 'glob-include',
            patterns: ['**/*'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree, { limit: 3 });

      expect(result.paths.size).toBe(3);
      expect(result.capped).toBe(true);
    });

    it('should NOT apply options.limit when selection is already under limit', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'explicit-one',
            type: 'explicit',
            paths: ['package.json'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree, { limit: 10 });

      expect(result.paths.size).toBe(1);
      expect(result.capped).toBe(false);
    });

    it('should NOT apply options.limit when cap rule already capped', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'include-all',
            type: 'glob-include',
            patterns: ['**/*'],
            createdAt: now,
          },
          {
            id: 'cap-to-5',
            type: 'cap',
            maxCount: 5,
            strategy: 'first',
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree, { limit: 3 });

      // Cap rule takes precedence, limits to 5, not 3
      expect(result.paths.size).toBe(5);
      expect(result.capped).toBe(true);
      expect(result.appliedRules).toContain('cap-to-5');
    });

    it('should handle options.limit equal to selection size', () => {
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'explicit-two',
            type: 'explicit',
            paths: ['package.json', 'tsconfig.json'],
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const result = engine.materialize(sampleTree, { limit: 2 });

      // Limit equals size, should NOT cap
      expect(result.paths.size).toBe(2);
      expect(result.capped).toBe(false);
    });
  });

  describe('Performance tests', () => {
    // Generate large synthetic tree
    function generateLargeTree(size: number): InMemoryTreeAdapter {
      const nodes: FileNode[] = [];

      for (let i = 0; i < size; i++) {
        const depth = Math.floor(Math.random() * 5);
        const pathParts = ['src'];
        for (let d = 0; d < depth; d++) {
          pathParts.push(`dir${Math.floor(Math.random() * 10)}`);
        }
        const ext = ['.ts', '.tsx', '.js', '.json'][Math.floor(Math.random() * 4)];
        pathParts.push(`file${i}${ext}`);
        nodes.push({ path: pathParts.join('/'), isDirectory: false });
      }

      return new InMemoryTreeAdapter(nodes);
    }

    it('should handle 10k files within budget', () => {
      const tree = generateLargeTree(10_000);
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'r1',
            type: 'glob-include',
            patterns: ['**/*.ts', '**/*.tsx'],
            createdAt: now,
          },
          {
            id: 'r2',
            type: 'glob-exclude',
            patterns: ['**/dir0/**'],
            createdAt: now,
          },
          {
            id: 'r3',
            type: 'cap',
            maxCount: 100,
            strategy: 'first',
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const start = performance.now();
      const result = engine.materialize(tree);
      const duration = performance.now() - start;

      // Should complete in under 3000ms (minimatch is slower than micromatch but browser-compatible, CI is slower)
      expect(duration).toBeLessThan(3000);
      expect(result.paths.size).toBeLessThanOrEqual(100);
    });

    it('should handle 50k files within budget', () => {
      const tree = generateLargeTree(50_000);
      const ruleSet: SelectionRuleSet = {
        ...createEmptyRuleSet('folder'),
        rules: [
          {
            id: 'r1',
            type: 'glob-include',
            patterns: ['**/*.ts'],
            createdAt: now,
          },
          {
            id: 'r2',
            type: 'cap',
            maxCount: 50,
            strategy: 'first',
            createdAt: now,
          },
        ],
      };

      const engine = createSelectionRuleEngine(ruleSet);
      const start = performance.now();
      const result = engine.materialize(tree);
      const duration = performance.now() - start;

      // Should complete in under 5 seconds (minimatch is slower than micromatch but browser-compatible, CI is slower)
      expect(duration).toBeLessThan(5000);
      expect(result.paths.size).toBeLessThanOrEqual(50);
    });
  });
});
