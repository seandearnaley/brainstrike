import { describe, expect, it } from 'vitest';
import {
  type CapRule,
  createEmptyMaterializedSelection,
  createEmptyRuleSet,
  DEFAULT_EXCLUDE_ROOTS,
  DEFAULT_INCLUDE_PATTERNS,
  DEFAULT_MAX_SELECTION_COUNT,
  type ExplicitRule,
  type GlobExcludeRule,
  type GlobIncludeRule,
  isCapRule,
  isExplicitRule,
  isGlobExcludeRule,
  isGlobIncludeRule,
  isRootExcludeRule,
  isRootIncludeRule,
  type RootExcludeRule,
  type RootIncludeRule,
  SELECTION_RULES_SCHEMA_VERSION,
  type SelectionRule,
} from '../schema';

describe('schema', () => {
  describe('SELECTION_RULES_SCHEMA_VERSION', () => {
    it('should be version 1', () => {
      expect(SELECTION_RULES_SCHEMA_VERSION).toBe(1);
    });
  });

  describe('defaults', () => {
    it('should have correct DEFAULT_MAX_SELECTION_COUNT', () => {
      expect(DEFAULT_MAX_SELECTION_COUNT).toBe(10);
    });

    it('should have DEFAULT_EXCLUDE_ROOTS as readonly array', () => {
      expect(DEFAULT_EXCLUDE_ROOTS).toContain('node_modules');
      expect(DEFAULT_EXCLUDE_ROOTS).toContain('.git');
      expect(DEFAULT_EXCLUDE_ROOTS).toContain('dist');
    });

    it('should have DEFAULT_INCLUDE_PATTERNS for TypeScript', () => {
      expect(DEFAULT_INCLUDE_PATTERNS).toContain('**/*.ts');
      expect(DEFAULT_INCLUDE_PATTERNS).toContain('**/*.tsx');
    });
  });

  describe('createEmptyRuleSet', () => {
    it('should create a valid empty rule set', () => {
      const ruleSet = createEmptyRuleSet('folder-123');

      expect(ruleSet.version).toBe(SELECTION_RULES_SCHEMA_VERSION);
      expect(ruleSet.folderId).toBe('folder-123');
      expect(ruleSet.rules).toEqual([]);
      expect(ruleSet.metadata.createdAt).toBeDefined();
      expect(ruleSet.metadata.updatedAt).toBeDefined();
    });

    it('should set timestamps to current time', () => {
      const before = new Date().toISOString();
      const ruleSet = createEmptyRuleSet('test');
      const after = new Date().toISOString();

      expect(ruleSet.metadata.createdAt >= before).toBe(true);
      expect(ruleSet.metadata.createdAt <= after).toBe(true);
    });
  });

  describe('createEmptyMaterializedSelection', () => {
    it('should create a valid empty materialized selection', () => {
      const selection = createEmptyMaterializedSelection();

      expect(selection.paths).toBeInstanceOf(Set);
      expect(selection.paths.size).toBe(0);
      expect(selection.appliedRules).toEqual([]);
      expect(selection.capped).toBe(false);
      expect(selection.originalCount).toBe(0);
      expect(selection.warnings).toEqual([]);
      expect(selection.materializedAt).toBeDefined();
    });
  });

  describe('type guards', () => {
    const explicitRule: ExplicitRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r1',
      paths: ['src/index.ts'],
      type: 'explicit',
    };

    const globIncludeRule: GlobIncludeRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r2',
      patterns: ['**/*.ts'],
      type: 'glob-include',
    };

    const globExcludeRule: GlobExcludeRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r3',
      patterns: ['**/*.test.ts'],
      type: 'glob-exclude',
    };

    const rootIncludeRule: RootIncludeRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r4',
      roots: ['src'],
      type: 'root-include',
    };

    const rootExcludeRule: RootExcludeRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r5',
      roots: ['node_modules'],
      type: 'root-exclude',
    };

    const capRule: CapRule = {
      createdAt: '2026-01-02T00:00:00Z',
      id: 'r6',
      maxCount: 50,
      strategy: 'first',
      type: 'cap',
    };

    const allRules: SelectionRule[] = [
      explicitRule,
      globIncludeRule,
      globExcludeRule,
      rootIncludeRule,
      rootExcludeRule,
      capRule,
    ];

    describe('isExplicitRule', () => {
      it('should return true for explicit rules', () => {
        expect(isExplicitRule(explicitRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'explicit')) {
          expect(isExplicitRule(rule)).toBe(false);
        }
      });
    });

    describe('isGlobIncludeRule', () => {
      it('should return true for glob-include rules', () => {
        expect(isGlobIncludeRule(globIncludeRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'glob-include')) {
          expect(isGlobIncludeRule(rule)).toBe(false);
        }
      });
    });

    describe('isGlobExcludeRule', () => {
      it('should return true for glob-exclude rules', () => {
        expect(isGlobExcludeRule(globExcludeRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'glob-exclude')) {
          expect(isGlobExcludeRule(rule)).toBe(false);
        }
      });
    });

    describe('isRootIncludeRule', () => {
      it('should return true for root-include rules', () => {
        expect(isRootIncludeRule(rootIncludeRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'root-include')) {
          expect(isRootIncludeRule(rule)).toBe(false);
        }
      });
    });

    describe('isRootExcludeRule', () => {
      it('should return true for root-exclude rules', () => {
        expect(isRootExcludeRule(rootExcludeRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'root-exclude')) {
          expect(isRootExcludeRule(rule)).toBe(false);
        }
      });
    });

    describe('isCapRule', () => {
      it('should return true for cap rules', () => {
        expect(isCapRule(capRule)).toBe(true);
      });

      it('should return false for other rule types', () => {
        for (const rule of allRules.filter((r) => r.type !== 'cap')) {
          expect(isCapRule(rule)).toBe(false);
        }
      });
    });
  });

  describe('rule structures', () => {
    it('should allow optional fields on ExplicitRule', () => {
      const rule: ExplicitRule = {
        createdAt: '2026-01-02T00:00:00Z',
        enabled: true,
        id: 'r1',
        label: 'Main entry point',
        mode: 'include',
        paths: ['src/index.ts'],
        priority: 10,
        type: 'explicit',
      };

      expect(rule.label).toBe('Main entry point');
      expect(rule.enabled).toBe(true);
      expect(rule.priority).toBe(10);
      expect(rule.mode).toBe('include');
    });

    it('should allow exclude mode on ExplicitRule', () => {
      const rule: ExplicitRule = {
        createdAt: '2026-01-02T00:00:00Z',
        id: 'r1',
        mode: 'exclude',
        paths: ['secrets.json'],
        type: 'explicit',
      };

      expect(rule.mode).toBe('exclude');
    });

    it('should allow basePath on GlobIncludeRule', () => {
      const rule: GlobIncludeRule = {
        basePath: 'src/components',
        createdAt: '2026-01-02T00:00:00Z',
        id: 'r1',
        patterns: ['*.ts'],
        type: 'glob-include',
      };

      expect(rule.basePath).toBe('src/components');
    });

    it('should allow maxDepth on RootIncludeRule', () => {
      const rule: RootIncludeRule = {
        createdAt: '2026-01-02T00:00:00Z',
        id: 'r1',
        maxDepth: 2,
        roots: ['src'],
        type: 'root-include',
      };

      expect(rule.maxDepth).toBe(2);
    });

    it('should allow seed on CapRule with random strategy', () => {
      const rule: CapRule = {
        createdAt: '2026-01-02T00:00:00Z',
        id: 'r1',
        maxCount: 50,
        seed: 12_345,
        strategy: 'random',
        type: 'cap',
      };

      expect(rule.strategy).toBe('random');
      expect(rule.seed).toBe(12_345);
    });

    it('should support all cap strategies', () => {
      const strategies: CapRule['strategy'][] = ['first', 'last', 'random', 'priority'];

      for (const strategy of strategies) {
        const rule: CapRule = {
          createdAt: '2026-01-02T00:00:00Z',
          id: 'r1',
          maxCount: 10,
          strategy,
          type: 'cap',
        };
        expect(rule.strategy).toBe(strategy);
      }
    });
  });
});
