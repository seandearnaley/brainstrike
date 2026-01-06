/**
 * @brainstrike/selection-rules
 *
 * Rule-based file selection schema and utilities for BrainStrike.
 *
 * @packageDocumentation
 */

// Engine (rule evaluation and materialization)
export {
  createSelectionRuleEngine,
  type FileNode,
  InMemoryTreeAdapter,
  type MaterializeOptions,
  type SelectionDiff,
  SelectionRuleEngine,
  type TreeAdapter,
} from './engine';
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
// Serialization
export {
  cloneMaterializedSelectionThroughSerialization,
  cloneRuleSetThroughSerialization,
  deserializeMaterializedSelection,
  deserializeRuleSet,
  type SerializedMaterializedSelection,
  type SerializedSelectionRuleSet,
  safeDeserializeMaterializedSelection,
  safeDeserializeRuleSet,
  serializeMaterializedSelection,
  serializeRuleSet,
  validateAndNormalizeRuleSet,
} from './serialization';
// Validation (Zod schemas and functions)
export {
  // Zod schemas
  CapRuleSchema,
  CapStrategySchema,
  ExplicitRuleSchema,
  GlobExcludeRuleSchema,
  GlobIncludeRuleSchema,
  // Glob pattern security (ReDoS prevention)
  type GlobPatternValidationResult,
  // Validation functions
  parseSelectionRule,
  parseSelectionRuleSet,
  RootExcludeRuleSchema,
  RootIncludeRuleSchema,
  SelectionRuleBaseSchema,
  SelectionRuleSchema,
  SelectionRuleSetMetadataSchema,
  SelectionRuleSetSchema,
  SelectionRulesSchemaVersionSchema,
  SelectionRuleTypeSchema,
  // Validated types (inferred from Zod)
  type ValidatedCapRule,
  type ValidatedExplicitRule,
  type ValidatedGlobExcludeRule,
  type ValidatedGlobIncludeRule,
  type ValidatedRootExcludeRule,
  type ValidatedRootIncludeRule,
  type ValidatedSelectionRule,
  type ValidatedSelectionRuleSet,
  type ValidationResult,
  validateGlobPattern,
  validateGlobPatterns,
  validateSelectionRule,
  validateSelectionRuleSet,
} from './validation';
