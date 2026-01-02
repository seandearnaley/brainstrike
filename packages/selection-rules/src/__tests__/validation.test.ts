import { describe, expect, it } from 'vitest';
import type { CapRule, ExplicitRule, GlobIncludeRule, RootIncludeRule } from '../schema';
import {
  parseSelectionRule,
  parseSelectionRuleSet,
  SelectionRuleSchema,
  SelectionRuleSetSchema,
  validateSelectionRule,
  validateSelectionRuleSet,
} from '../validation';

describe('validation', () => {
  const validExplicitRule: ExplicitRule = {
    id: 'rule-1',
    type: 'explicit',
    paths: ['src/index.ts'],
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  const validGlobIncludeRule: GlobIncludeRule = {
    id: 'rule-2',
    type: 'glob-include',
    patterns: ['**/*.ts'],
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  const validRootIncludeRule: RootIncludeRule = {
    id: 'rule-3',
    type: 'root-include',
    roots: ['src'],
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  const validCapRule: CapRule = {
    id: 'rule-4',
    type: 'cap',
    maxCount: 50,
    strategy: 'first',
    createdAt: '2026-01-02T00:00:00.000Z',
  };

  describe('validateSelectionRule', () => {
    it('should return success for valid explicit rule', () => {
      const result = validateSelectionRule(validExplicitRule);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validExplicitRule);
      }
    });

    it('should return success for valid glob-include rule', () => {
      const result = validateSelectionRule(validGlobIncludeRule);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validGlobIncludeRule);
      }
    });

    it('should return success for valid cap rule', () => {
      const result = validateSelectionRule(validCapRule);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validCapRule);
      }
    });

    it('should accept optional fields', () => {
      const ruleWithOptionals = {
        ...validExplicitRule,
        label: 'My explicit rule',
        enabled: true,
        priority: 10,
        mode: 'include' as const,
      };

      const result = validateSelectionRule(ruleWithOptionals);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.label).toBe('My explicit rule');
        expect(result.data.enabled).toBe(true);
        expect(result.data.priority).toBe(10);
      }
    });

    it('should fail for missing required id', () => {
      const invalidRule = { ...validExplicitRule, id: undefined };
      (invalidRule as Record<string, unknown>).id = undefined;

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.errors.issues;
        expect(issues.some((i) => i.path.includes('id'))).toBe(true);
      }
    });

    it('should fail for empty id', () => {
      const invalidRule = { ...validExplicitRule, id: '' };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.issues[0].message).toContain('required');
      }
    });

    it('should fail for invalid rule type', () => {
      const invalidRule = { ...validExplicitRule, type: 'unknown-type' };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
    });

    it('should fail for invalid createdAt format', () => {
      const invalidRule = { ...validExplicitRule, createdAt: 'not-a-date' };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.issues.some((i) => i.path.includes('createdAt'))).toBe(true);
      }
    });

    it('should fail for empty paths array in explicit rule', () => {
      const invalidRule = { ...validExplicitRule, paths: [] };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.issues[0].message).toContain('path');
      }
    });

    it('should fail for empty patterns array in glob rule', () => {
      const invalidRule = { ...validGlobIncludeRule, patterns: [] };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.issues[0].message).toContain('pattern');
      }
    });

    it('should fail for negative maxCount in cap rule', () => {
      const invalidRule = { ...validCapRule, maxCount: -5 };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
    });

    it('should fail for zero maxCount in cap rule', () => {
      const invalidRule = { ...validCapRule, maxCount: 0 };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
    });

    it('should fail for invalid cap strategy', () => {
      const invalidRule = { ...validCapRule, strategy: 'invalid' };

      const result = validateSelectionRule(invalidRule);

      expect(result.success).toBe(false);
    });

    it('should accept all valid cap strategies', () => {
      const strategies = ['first', 'last', 'random', 'priority'] as const;

      for (const strategy of strategies) {
        const rule = { ...validCapRule, strategy };
        const result = validateSelectionRule(rule);
        expect(result.success).toBe(true);
      }
    });

    it('should fail for null input', () => {
      const result = validateSelectionRule(null);
      expect(result.success).toBe(false);
    });

    it('should fail for undefined input', () => {
      const result = validateSelectionRule(undefined);
      expect(result.success).toBe(false);
    });

    it('should fail for primitive input', () => {
      const result = validateSelectionRule('not-an-object');
      expect(result.success).toBe(false);
    });
  });

  describe('validateSelectionRuleSet', () => {
    const validRuleSet = {
      version: 1,
      folderId: 'folder-123',
      rules: [validExplicitRule, validGlobIncludeRule],
      metadata: {
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    };

    it('should return success for valid rule set', () => {
      const result = validateSelectionRuleSet(validRuleSet);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(1);
        expect(result.data.folderId).toBe('folder-123');
        expect(result.data.rules).toHaveLength(2);
      }
    });

    it('should accept empty rules array', () => {
      const emptyRuleSet = { ...validRuleSet, rules: [] };
      const result = validateSelectionRuleSet(emptyRuleSet);

      expect(result.success).toBe(true);
    });

    it('should accept optional metadata fields', () => {
      const ruleSetWithOptionals = {
        ...validRuleSet,
        metadata: {
          ...validRuleSet.metadata,
          migratedFrom: 'explicit-set' as const,
          description: 'Test rule set',
        },
      };

      const result = validateSelectionRuleSet(ruleSetWithOptionals);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata.migratedFrom).toBe('explicit-set');
        expect(result.data.metadata.description).toBe('Test rule set');
      }
    });

    it('should fail for wrong version', () => {
      const invalidRuleSet = { ...validRuleSet, version: 2 };
      const result = validateSelectionRuleSet(invalidRuleSet);

      expect(result.success).toBe(false);
    });

    it('should fail for missing folderId', () => {
      const { folderId: _removed, ...invalidRuleSet } = validRuleSet;
      const result = validateSelectionRuleSet(invalidRuleSet);

      expect(result.success).toBe(false);
    });

    it('should fail for empty folderId', () => {
      const invalidRuleSet = { ...validRuleSet, folderId: '' };
      const result = validateSelectionRuleSet(invalidRuleSet);

      expect(result.success).toBe(false);
    });

    it('should fail if any rule is invalid', () => {
      const invalidRuleSet = {
        ...validRuleSet,
        rules: [validExplicitRule, { type: 'invalid' }],
      };

      const result = validateSelectionRuleSet(invalidRuleSet);

      expect(result.success).toBe(false);
    });

    it('should fail for invalid metadata timestamps', () => {
      const invalidRuleSet = {
        ...validRuleSet,
        metadata: {
          createdAt: 'invalid',
          updatedAt: 'invalid',
        },
      };

      const result = validateSelectionRuleSet(invalidRuleSet);

      expect(result.success).toBe(false);
    });
  });

  describe('parseSelectionRule', () => {
    it('should return parsed rule for valid input', () => {
      const rule = parseSelectionRule(validExplicitRule);
      expect(rule).toEqual(validExplicitRule);
    });

    it('should throw ZodError for invalid input', () => {
      expect(() => parseSelectionRule({ type: 'invalid' })).toThrow();
    });

    it('should throw ZodError for missing required fields', () => {
      expect(() => parseSelectionRule({ type: 'explicit' })).toThrow();
    });
  });

  describe('parseSelectionRuleSet', () => {
    const validRuleSet = {
      version: 1,
      folderId: 'folder-123',
      rules: [],
      metadata: {
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    };

    it('should return parsed rule set for valid input', () => {
      const ruleSet = parseSelectionRuleSet(validRuleSet);
      expect(ruleSet).toEqual(validRuleSet);
    });

    it('should throw ZodError for invalid input', () => {
      expect(() => parseSelectionRuleSet({ version: 2 })).toThrow();
    });
  });

  describe('Zod schemas', () => {
    it('should have discriminated union for SelectionRuleSchema', () => {
      // Verify that the schema uses discriminated union on 'type'
      const definition = SelectionRuleSchema._def;
      expect(definition.typeName).toBe('ZodDiscriminatedUnion');
    });

    it('should validate all rule types through union', () => {
      const rules = [
        validExplicitRule,
        validGlobIncludeRule,
        { ...validGlobIncludeRule, id: 'glob-ex', type: 'glob-exclude' as const },
        validRootIncludeRule,
        { ...validRootIncludeRule, id: 'root-ex', type: 'root-exclude' as const },
        validCapRule,
      ];

      for (const rule of rules) {
        const result = SelectionRuleSchema.safeParse(rule);
        expect(result.success).toBe(true);
      }
    });

    it('should have correct shape for SelectionRuleSetSchema', () => {
      const shape = SelectionRuleSetSchema.shape;
      expect(shape.version).toBeDefined();
      expect(shape.folderId).toBeDefined();
      expect(shape.rules).toBeDefined();
      expect(shape.metadata).toBeDefined();
    });
  });
});
