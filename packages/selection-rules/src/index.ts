/**
 * @brainstrike/selection-rules
 *
 * Rule-based file selection schema and utilities for BrainStrike.
 *
 * @packageDocumentation
 */

export {
  type CapRule,
  type CapStrategy,
  createEmptyMaterializedSelection,
  // Factory functions
  createEmptyRuleSet,
  DEFAULT_EXCLUDE_ROOTS,
  DEFAULT_INCLUDE_PATTERNS,
  // Defaults
  DEFAULT_MAX_SELECTION_COUNT,
  // Concrete rule types
  type ExplicitRule,
  type GlobExcludeRule,
  type GlobIncludeRule,
  isCapRule,
  // Type guards
  isExplicitRule,
  isGlobExcludeRule,
  isGlobIncludeRule,
  isRootExcludeRule,
  isRootIncludeRule,
  // Materialization
  type MaterializationWarning,
  type MaterializedSelection,
  type RootExcludeRule,
  type RootIncludeRule,
  // Schema version
  SELECTION_RULES_SCHEMA_VERSION,
  // Union type
  type SelectionRule,
  // Base interface
  type SelectionRuleBase,
  type SelectionRuleSet,
  // Rule set
  type SelectionRuleSetMetadata,
  type SelectionRulesSchemaVersion,
  // Rule types
  type SelectionRuleType,
} from './schema';
