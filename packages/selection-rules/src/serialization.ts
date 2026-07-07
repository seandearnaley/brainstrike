/**
 * Selection Rules Serialization
 *
 * Serialize and deserialize selection rules for storage and transmission.
 * Handles Set↔Array conversion and provides round-trip guarantees.
 *
 * @see validation.ts for runtime validation
 */

import type { MaterializedSelection, SelectionRuleSet } from './schema';
import { createEmptyMaterializedSelection, createEmptyRuleSet } from './schema';
import { parseSelectionRuleSet, validateSelectionRuleSet } from './validation';

// ============================================================================
// Serialized Types
// ============================================================================

/**
 * Serialized version of MaterializedSelection.
 *
 * The main difference is that `paths` is an array instead of a Set,
 * since JSON doesn't support Set serialization.
 */
export type SerializedMaterializedSelection = Omit<MaterializedSelection, 'paths'> & {
  paths: string[];
};

/**
 * Serialized version of SelectionRuleSet.
 *
 * Currently identical to SelectionRuleSet since it doesn't contain Sets.
 * Defined for API clarity and future extensibility.
 */
export type SerializedSelectionRuleSet = SelectionRuleSet;

// ============================================================================
// Rule Set Serialization
// ============================================================================

/**
 * Serialize a SelectionRuleSet for storage.
 *
 * @param ruleSet - The rule set to serialize
 * @returns JSON string
 */
export function serializeRuleSet(ruleSet: SelectionRuleSet): string {
  return JSON.stringify(ruleSet);
}

/**
 * Deserialize a SelectionRuleSet from storage.
 *
 * @param json - JSON string to parse
 * @returns Validated rule set
 * @throws Error if JSON is invalid or rule set fails validation
 */
export function deserializeRuleSet(json: string): SelectionRuleSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Cast needed due to exactOptionalPropertyTypes mismatch between Zod output and schema types
  return parseSelectionRuleSet(parsed) as SelectionRuleSet;
}

/**
 * Safely deserialize a SelectionRuleSet, returning a default on failure.
 *
 * @param json - JSON string to parse
 * @param folderId - Folder ID for the default rule set
 * @returns Validated rule set or default empty rule set
 */
export function safeDeserializeRuleSet(json: string, folderId: string): SelectionRuleSet {
  try {
    return deserializeRuleSet(json);
  } catch {
    return createEmptyRuleSet(folderId);
  }
}

/**
 * Validate and normalize a rule set object.
 *
 * @param data - Unknown data to validate
 * @returns Validation result with typed rule set or errors
 */
export function validateAndNormalizeRuleSet(
  data: unknown
): ReturnType<typeof validateSelectionRuleSet> {
  return validateSelectionRuleSet(data);
}

// ============================================================================
// Materialized Selection Serialization
// ============================================================================

/**
 * Serialize a MaterializedSelection for storage.
 *
 * Converts paths Set to array for JSON compatibility.
 *
 * @param selection - The materialized selection to serialize
 * @returns JSON string
 */
export function serializeMaterializedSelection(selection: MaterializedSelection): string {
  const serialized: SerializedMaterializedSelection = {
    ...selection,
    paths: Array.from(selection.paths),
  };
  return JSON.stringify(serialized);
}

/**
 * Deserialize a MaterializedSelection from storage.
 *
 * Converts paths array back to Set.
 *
 * @param json - JSON string to parse
 * @returns Materialized selection with paths as Set
 * @throws Error if JSON is invalid or structure is unexpected
 */
export function deserializeMaterializedSelection(json: string): MaterializedSelection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!isSerializedMaterializedSelection(parsed)) {
    throw new Error('Invalid materialized selection structure');
  }

  return {
    appliedRules: parsed.appliedRules,
    capped: parsed.capped,
    materializedAt: parsed.materializedAt,
    originalCount: parsed.originalCount,
    paths: new Set(parsed.paths),
    warnings: parsed.warnings,
  };
}

/**
 * Safely deserialize a MaterializedSelection, returning empty on failure.
 *
 * @param json - JSON string to parse
 * @returns Materialized selection or empty default
 */
export function safeDeserializeMaterializedSelection(json: string): MaterializedSelection {
  try {
    return deserializeMaterializedSelection(json);
  } catch {
    return createEmptyMaterializedSelection();
  }
}

// ============================================================================
// Type Guards for Serialized Data
// ============================================================================

/**
 * Type guard for SerializedMaterializedSelection.
 */
function isSerializedMaterializedSelection(
  value: unknown
): value is SerializedMaterializedSelection {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    Array.isArray(obj['paths']) &&
    (obj['paths'] as unknown[]).every((p) => typeof p === 'string') &&
    Array.isArray(obj['appliedRules']) &&
    typeof obj['capped'] === 'boolean' &&
    typeof obj['originalCount'] === 'number' &&
    Array.isArray(obj['warnings']) &&
    typeof obj['materializedAt'] === 'string'
  );
}

// ============================================================================
// Round-Trip Utilities
// ============================================================================

/**
 * Clone a rule set through serialization.
 *
 * Useful for ensuring immutability or testing serialization.
 *
 * @param ruleSet - Rule set to clone
 * @returns Deep clone of the rule set
 */
export function cloneRuleSetThroughSerialization(ruleSet: SelectionRuleSet): SelectionRuleSet {
  return deserializeRuleSet(serializeRuleSet(ruleSet));
}

/**
 * Clone a materialized selection through serialization.
 *
 * @param selection - Selection to clone
 * @returns Deep clone with new Set instance
 */
export function cloneMaterializedSelectionThroughSerialization(
  selection: MaterializedSelection
): MaterializedSelection {
  return deserializeMaterializedSelection(serializeMaterializedSelection(selection));
}
