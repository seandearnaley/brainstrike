import { describe, expect, it } from 'vitest';
import type { CapRule, ExplicitRule, GlobIncludeRule, RootIncludeRule } from '../schema';
import {
  parseSelectionRule,
  parseSelectionRuleSet,
  SelectionRuleSchema,
  SelectionRuleSetSchema,
  validateGlobPattern,
  validateGlobPatterns,
  validateSelectionRule,
  validateSelectionRuleSet,
} from '../validation';

describe('glob pattern security (ReDoS prevention)', () => {
  describe('validateGlobPattern', () => {
    it('should accept valid simple patterns', () => {
      expect(validateGlobPattern('*.ts').valid).toBe(true);
      expect(validateGlobPattern('**/*.tsx').valid).toBe(true);
      expect(validateGlobPattern('src/**/*.ts').valid).toBe(true);
      expect(validateGlobPattern('*.{ts,tsx,js}').valid).toBe(true);
    });

    it('should accept patterns with reasonable globstar count', () => {
      expect(validateGlobPattern('**/*.ts').valid).toBe(true);
      expect(validateGlobPattern('src/**/test/**/*.ts').valid).toBe(true);
      expect(validateGlobPattern('a/**/b/**/c/**/d/**/e.ts').valid).toBe(true); // 4 globstars
    });

    it('should reject patterns exceeding globstar limit', () => {
      const result = validateGlobPattern('**/**/**/**/**/**/*.ts'); // 6 globstars
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('globstar');
      }
    });

    it('should reject patterns exceeding length limit', () => {
      const longPattern = `${'a'.repeat(300)}/*.ts`;
      const result = validateGlobPattern(longPattern);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('length');
      }
    });

    it('should reject patterns with three or more consecutive asterisks', () => {
      const result = validateGlobPattern('***/*.ts');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('dangerous');
      }
    });

    it('should reject brace expansions with too many options', () => {
      const manyOptions = Array.from({ length: 25 }, (_, i) => `ext${i}`).join(',');
      const result = validateGlobPattern(`*.{${manyOptions}}`);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('Brace expansion');
      }
    });

    it('should accept brace expansions with reasonable options', () => {
      expect(validateGlobPattern('*.{ts,tsx,js,jsx,json}').valid).toBe(true);
    });
  });

  describe('validateGlobPatterns', () => {
    it('should accept array of valid patterns', () => {
      const result = validateGlobPatterns(['*.ts', '**/*.tsx', 'src/**/*.js']);
      expect(result.valid).toBe(true);
    });

    it('should reject if any pattern is invalid', () => {
      const result = validateGlobPatterns(['*.ts', '**/**/**/**/**/**/*.tsx', '*.js']);
      expect(result.valid).toBe(false);
    });

    it('should accept empty array', () => {
      const result = validateGlobPatterns([]);
      expect(result.valid).toBe(true);
    });
  });

  describe('Zod schema integration', () => {
    it('should reject glob-include rules with dangerous patterns', () => {
      const dangerousRule = {
        id: 'dangerous',
        type: 'glob-include' as const,
        patterns: ['**/**/**/**/**/**/*.ts'], // 6 globstars - exceeds limit
        createdAt: '2026-01-02T00:00:00.000Z',
      };

      const result = validateSelectionRule(dangerousRule);
      expect(result.success).toBe(false);
    });

    it('should reject glob-exclude rules with dangerous patterns', () => {
      const dangerousRule = {
        id: 'dangerous',
        type: 'glob-exclude' as const,
        patterns: ['a'.repeat(300)], // exceeds length limit
        createdAt: '2026-01-02T00:00:00.000Z',
      };

      const result = validateSelectionRule(dangerousRule);
      expect(result.success).toBe(false);
    });

    it('should accept safe glob patterns in rules', () => {
      const safeRule = {
        id: 'safe',
        type: 'glob-include' as const,
        patterns: ['**/*.ts', 'src/**/*.tsx', '*.{ts,tsx,js}'],
        createdAt: '2026-01-02T00:00:00.000Z',
      };

      const result = validateSelectionRule(safeRule);
      expect(result.success).toBe(true);
    });

    it('should reject rules with too many patterns', () => {
      const tooManyPatterns = Array.from({ length: 55 }, (_, i) => `pattern${i}/*.ts`);
      const rule = {
        id: 'too-many',
        type: 'glob-include' as const,
        patterns: tooManyPatterns,
        createdAt: '2026-01-02T00:00:00.000Z',
      };

      const result = validateSelectionRule(rule);
      expect(result.success).toBe(false);
    });
  });
});

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
      // In Zod v4, discriminated unions have _def.type === 'union' and a discriminator property
      const definition = SelectionRuleSchema._def as {
        type?: string;
        discriminator?: string;
      };
      expect(definition.type).toBe('union');
      expect(definition.discriminator).toBe('type');
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
