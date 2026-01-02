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
  id: z.string().min(1, 'Rule ID is required'),
  type: SelectionRuleTypeSchema,
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  createdAt: z.string().datetime({ message: 'createdAt must be ISO 8601 datetime' }),
  priority: z.number().int().optional(),
});

// ============================================================================
// Concrete Rule Schemas
// ============================================================================

/** Explicit file selection rule */
export const ExplicitRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('explicit'),
  paths: z.array(z.string()).min(1, 'At least one path is required'),
  mode: z.enum(['include', 'exclude']).optional(),
});

/** Glob pattern inclusion rule */
export const GlobIncludeRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('glob-include'),
  patterns: z.array(z.string()).min(1, 'At least one pattern is required'),
  basePath: z.string().optional(),
});

/** Glob pattern exclusion rule */
export const GlobExcludeRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('glob-exclude'),
  patterns: z.array(z.string()).min(1, 'At least one pattern is required'),
  basePath: z.string().optional(),
});

/** Root directory inclusion rule */
export const RootIncludeRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('root-include'),
  roots: z.array(z.string()).min(1, 'At least one root is required'),
  maxDepth: z.number().int().nonnegative().optional(),
});

/** Root directory exclusion rule */
export const RootExcludeRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('root-exclude'),
  roots: z.array(z.string()).min(1, 'At least one root is required'),
});

/** Selection cap/limit rule */
export const CapRuleSchema = SelectionRuleBaseSchema.extend({
  type: z.literal('cap'),
  maxCount: z.number().int().positive('maxCount must be positive'),
  strategy: CapStrategySchema,
  seed: z.number().int().optional(),
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
  updatedAt: z.string().datetime({ message: 'updatedAt must be ISO 8601 datetime' }),
  migratedFrom: z.literal('explicit-set').optional(),
  description: z.string().optional(),
});

/** Complete rule set for a folder context */
export const SelectionRuleSetSchema = z.object({
  version: SelectionRulesSchemaVersionSchema,
  folderId: z.string().min(1, 'folderId is required'),
  rules: z.array(SelectionRuleSchema),
  metadata: SelectionRuleSetMetadataSchema,
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
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
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
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
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
