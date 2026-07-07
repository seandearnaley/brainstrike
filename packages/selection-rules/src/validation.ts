/**
 * Selection Rules Validation
 *
 * Runtime validation for selection rules using Zod.
 * Provides type-safe parsing and validation with descriptive error messages.
 *
 * @see schema.ts for TypeScript type definitions
 */

import { z } from 'zod';
import { SELECTION_RULES_SCHEMA_VERSION } from './schema';

// ============================================================================
// Glob Pattern Security (ReDoS Prevention)
// ============================================================================

/** Maximum allowed pattern length to prevent ReDoS */
const MAX_PATTERN_LENGTH = 256;

/** Maximum number of globstar (**) segments allowed */
const MAX_GLOBSTAR_COUNT = 5;

/**
 * Result of glob pattern validation.
 */
export type GlobPatternValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate a glob pattern for safety (ReDoS prevention).
 *
 * Checks for patterns that could cause catastrophic backtracking in the
 * regex engine when converted by minimatch.
 *
 * @param pattern - The glob pattern to validate
 * @returns Validation result with reason if invalid
 */
export function validateGlobPattern(pattern: string): GlobPatternValidationResult {
  // Check pattern length
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      reason: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`,
      valid: false,
    };
  }

  // Count globstar (**) occurrences - these are the main ReDoS risk
  const globstarCount = (pattern.match(/\*\*/g) ?? []).length;
  if (globstarCount > MAX_GLOBSTAR_COUNT) {
    return {
      reason: `Pattern has too many globstar (**) segments (max: ${MAX_GLOBSTAR_COUNT})`,
      valid: false,
    };
  }

  // Detect potentially dangerous nested patterns
  // These patterns can cause exponential backtracking
  const dangerousPatterns = [
    /\*{3,}/, // Three or more consecutive asterisks
    /\(\*+\)\+/, // Nested quantifiers like (*)+
    /\[\*+\]\+/, // Nested quantifiers like [*]+
  ];

  for (const dangerous of dangerousPatterns) {
    if (dangerous.test(pattern)) {
      return {
        reason: 'Pattern contains potentially dangerous nested quantifiers',
        valid: false,
      };
    }
  }

  // Check for excessively long brace expansions
  const braceMatch = pattern.match(/\{([^}]+)\}/g);
  if (braceMatch) {
    for (const brace of braceMatch) {
      const options = brace.slice(1, -1).split(',');
      if (options.length > 20) {
        return {
          reason: 'Brace expansion has too many options (max: 20)',
          valid: false,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate multiple glob patterns.
 *
 * @param patterns - Array of patterns to validate
 * @returns First invalid pattern result, or success if all valid
 */
export function validateGlobPatterns(patterns: string[]): GlobPatternValidationResult {
  for (const pattern of patterns) {
    const result = validateGlobPattern(pattern);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

/**
 * Zod refinement for safe glob patterns.
 * Uses superRefine for dynamic error messages in Zod v4.
 */
const safeGlobPatternSchema = z.string().superRefine((pattern, ctx) => {
  const result = validateGlobPattern(pattern);
  if (!result.valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.reason,
    });
  }
});

// ============================================================================
// Schema Version
// ============================================================================

/** Schema version validator */
export const SelectionRulesSchemaVersionSchema = z.literal(SELECTION_RULES_SCHEMA_VERSION);

// ============================================================================
// Rule Types
// ============================================================================

/** Valid rule types */
export const SelectionRuleTypeSchema = z.enum([
  'explicit',
  'glob-include',
  'glob-exclude',
  'root-include',
  'root-exclude',
  'cap',
]);

/** Cap strategy options */
export const CapStrategySchema = z.enum(['first', 'last', 'random', 'priority']);

// ============================================================================
// Base Rule Schema
// ============================================================================

/** Base rule fields shared by all rule types */
export const SelectionRuleBaseSchema = z.object({
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 datetime' }),
  enabled: z.boolean().optional(),
  id: z.string().min(1, 'Rule ID is required'),
  label: z.string().optional(),
  priority: z.number().int().optional(),
  type: SelectionRuleTypeSchema,
});

// ============================================================================
// Concrete Rule Schemas
// ============================================================================

/** Explicit file selection rule */
export const ExplicitRuleSchema = SelectionRuleBaseSchema.extend({
  mode: z.enum(['include', 'exclude']).optional(),
  paths: z.array(z.string()).min(1, 'At least one path is required'),
  type: z.literal('explicit'),
});

/** Glob pattern inclusion rule with ReDoS-safe pattern validation */
export const GlobIncludeRuleSchema = SelectionRuleBaseSchema.extend({
  basePath: z.string().optional(),
  patterns: z
    .array(safeGlobPatternSchema)
    .min(1, 'At least one pattern is required')
    .max(50, 'Too many patterns (max: 50)'),
  type: z.literal('glob-include'),
});

/** Glob pattern exclusion rule with ReDoS-safe pattern validation */
export const GlobExcludeRuleSchema = SelectionRuleBaseSchema.extend({
  basePath: z.string().optional(),
  patterns: z
    .array(safeGlobPatternSchema)
    .min(1, 'At least one pattern is required')
    .max(50, 'Too many patterns (max: 50)'),
  type: z.literal('glob-exclude'),
});

/** Root directory inclusion rule */
export const RootIncludeRuleSchema = SelectionRuleBaseSchema.extend({
  maxDepth: z.number().int().nonnegative().optional(),
  roots: z.array(z.string()).min(1, 'At least one root is required'),
  type: z.literal('root-include'),
});

/** Root directory exclusion rule */
export const RootExcludeRuleSchema = SelectionRuleBaseSchema.extend({
  roots: z.array(z.string()).min(1, 'At least one root is required'),
  type: z.literal('root-exclude'),
});

/** Selection cap/limit rule */
export const CapRuleSchema = SelectionRuleBaseSchema.extend({
  maxCount: z.number().int().positive('maxCount must be positive'),
  seed: z.number().int().optional(),
  strategy: CapStrategySchema,
  type: z.literal('cap'),
});

// ============================================================================
// Union Schema (Discriminated Union)
// ============================================================================

/** Union of all concrete rule schemas */
export const SelectionRuleSchema = z.discriminatedUnion('type', [
  ExplicitRuleSchema,
  GlobIncludeRuleSchema,
  GlobExcludeRuleSchema,
  RootIncludeRuleSchema,
  RootExcludeRuleSchema,
  CapRuleSchema,
]);

// ============================================================================
// Rule Set Schemas
// ============================================================================

/** Rule set metadata */
export const SelectionRuleSetMetadataSchema = z.object({
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 datetime' }),
  description: z.string().optional(),
  migratedFrom: z.literal('explicit-set').optional(),
  updatedAt: z.string().datetime({ message: 'updatedAt must be ISO 8601 datetime' }),
});

/** Complete rule set for a folder context */
export const SelectionRuleSetSchema = z.object({
  folderId: z.string().min(1, 'folderId is required'),
  metadata: SelectionRuleSetMetadataSchema,
  rules: z.array(SelectionRuleSchema),
  version: SelectionRulesSchemaVersionSchema,
});

// ============================================================================
// Validation Functions
// ============================================================================

/** Result of validation */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: z.ZodError };

/**
 * Validate a selection rule with descriptive error messages.
 *
 * @param rule - The rule to validate (unknown input)
 * @returns Typed rule or descriptive errors
 */
export function validateSelectionRule(
  rule: unknown
): ValidationResult<z.infer<typeof SelectionRuleSchema>> {
  const result = SelectionRuleSchema.safeParse(rule);
  if (result.success) {
    return { data: result.data, success: true };
  }
  return { errors: result.error, success: false };
}

/**
 * Validate a selection rule set.
 *
 * @param ruleSet - The rule set to validate (unknown input)
 * @returns Typed rule set or descriptive errors
 */
export function validateSelectionRuleSet(
  ruleSet: unknown
): ValidationResult<z.infer<typeof SelectionRuleSetSchema>> {
  const result = SelectionRuleSetSchema.safeParse(ruleSet);
  if (result.success) {
    return { data: result.data, success: true };
  }
  return { errors: result.error, success: false };
}

/**
 * Parse a selection rule, throwing on invalid input.
 *
 * @param rule - The rule to parse
 * @returns Typed rule
 * @throws z.ZodError on validation failure
 */
export function parseSelectionRule(rule: unknown): z.infer<typeof SelectionRuleSchema> {
  return SelectionRuleSchema.parse(rule);
}

/**
 * Parse a selection rule set, throwing on invalid input.
 *
 * @param ruleSet - The rule set to parse
 * @returns Typed rule set
 * @throws z.ZodError on validation failure
 */
export function parseSelectionRuleSet(ruleSet: unknown): z.infer<typeof SelectionRuleSetSchema> {
  return SelectionRuleSetSchema.parse(ruleSet);
}

// ============================================================================
// Type Exports (inferred from Zod schemas)
// ============================================================================

/** Inferred types from Zod schemas for runtime-validated data */
export type ValidatedSelectionRule = z.infer<typeof SelectionRuleSchema>;
export type ValidatedSelectionRuleSet = z.infer<typeof SelectionRuleSetSchema>;
export type ValidatedExplicitRule = z.infer<typeof ExplicitRuleSchema>;
export type ValidatedGlobIncludeRule = z.infer<typeof GlobIncludeRuleSchema>;
export type ValidatedGlobExcludeRule = z.infer<typeof GlobExcludeRuleSchema>;
export type ValidatedRootIncludeRule = z.infer<typeof RootIncludeRuleSchema>;
export type ValidatedRootExcludeRule = z.infer<typeof RootExcludeRuleSchema>;
export type ValidatedCapRule = z.infer<typeof CapRuleSchema>;
