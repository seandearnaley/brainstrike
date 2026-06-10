---
title: "ADR: Selection Rules v1"
sidebar_position: 2
---

# ADR-0001: Selection Rules v1 — Rule-based File Selection Model

| Field       | Value                           |
|-------------|---------------------------------|
| **Status**  | Proposed                        |
| **Date**    | 2026-01-02                      |
| **Authors** | BrainStrike Team                |
| **Epic**    | BST-131 (Selection Engine v2)   |
| **Ticket**  | BST-139                         |

## Context

### Current Selection Model (v0)

The existing file selection system uses **explicit composite-key sets** with the following characteristics:

1. **Composite Key Format**: Files are stored as `"<folderId>|@|<path>"` strings in a `Set<string>`
2. **Per-Folder State**: Each workspace folder maintains its own selection state in `folderStates`
3. **Flat Enumeration**: Every selected file is individually tracked — no pattern matching
4. **Hard Limits**: Selection capped by `maxSelectionCount` (default: 10)
5. **UI-Driven**: Selection happens via checkbox clicks in the file tree

### Data Flow (Current)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SELECTION DATA FLOW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐   │
│  │   UI Layer       │───▶│   Store Actions  │───▶│   Persistence        │   │
│  │                  │    │                  │    │                      │   │
│  │ • Tree checkbox  │    │ • addSelectedFile│    │ • serializeState()   │   │
│  │ • Folder select  │    │ • toggleSelected │    │ • Set → Array        │   │
│  │ • Dialog confirm │    │ • clearSelected  │    │ • localStorage/      │   │
│  │                  │    │ • setSelectedFile│    │   zustand persist    │   │
│  └──────────────────┘    └──────────────────┘    └──────────────────────┘   │
│          │                        │                        │                │
│          ▼                        ▼                        ▼                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                     DOWNSTREAM CONSUMERS                              │   │
│  │                                                                       │   │
│  │  • file-import-coordinator.ts  — Iterates selectedFilePaths          │   │
│  │  • enhanced-import.ts          — Takes Set<string> as input          │   │
│  │  • Report generation           — Reads selected files for context    │   │
│  │  • Token counting              — Calculates budget from selection    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Pain Points

| Issue | Description |
|-------|-------------|
| **Scalability** | Selecting 1000+ files requires 1000+ set entries |
| **No Pattern Matching** | Cannot express "all `*.ts` files" declaratively |
| **No Exclusions** | Cannot say "all files except `node_modules`" |
| **Folder State Complexity** | Rules don't compose across folders |
| **Migration Burden** | Changing limits or adding patterns requires manual updates |

### Goals for Selection Rules v1

1. **Declarative**: Express intent via rules, not exhaustive enumeration
2. **Composable**: Rules can be combined with clear precedence
3. **Efficient**: Materialize only when needed; store rules, not expanded sets
4. **Backward-Compatible**: Existing selections should migrate cleanly
5. **Extensible**: Schema supports future rule types without breaking changes

## Decision

We will introduce a **rule-based selection model** that coexists with explicit selections during a transition period. The model uses a hierarchical rule structure with well-defined precedence.

### Rule Schema (v1)

```typescript
/**
 * Selection Rules Schema v1
 *
 * A versioned schema for rule-based file selection.
 * Rules are evaluated in precedence order to produce a materialized selection.
 */

/** Schema version for migration support */
export const SELECTION_RULES_SCHEMA_VERSION = 1 as const;

/** Rule types ordered by evaluation precedence (highest first) */
export type SelectionRuleType =
  | 'explicit'      // Individual file paths (legacy compatibility)
  | 'glob-include'  // Pattern-based inclusion
  | 'glob-exclude'  // Pattern-based exclusion
  | 'root-include'  // Include entire directory tree
  | 'root-exclude'  // Exclude entire directory tree
  | 'cap';          // Limit total selection count

/** Base rule structure */
export interface SelectionRuleBase {
  /** Unique identifier for the rule */
  id: string;
  /** Rule type determines evaluation behavior */
  type: SelectionRuleType;
  /** Human-readable description */
  label?: string;
  /** Rule is active (default: true) */
  enabled?: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Priority within same type (higher = evaluated first) */
  priority?: number;
}

/** Explicit file selection (legacy compatibility) */
export interface ExplicitRule extends SelectionRuleBase {
  type: 'explicit';
  /** Array of file paths (not composite keys — folderId is context) */
  paths: string[];
}

/** Glob pattern inclusion */
export interface GlobIncludeRule extends SelectionRuleBase {
  type: 'glob-include';
  /** Glob patterns (e.g., "**/*.ts", "src/**/*.tsx") */
  patterns: string[];
}

/** Glob pattern exclusion */
export interface GlobExcludeRule extends SelectionRuleBase {
  type: 'glob-exclude';
  /** Glob patterns to exclude */
  patterns: string[];
}

/** Root directory inclusion */
export interface RootIncludeRule extends SelectionRuleBase {
  type: 'root-include';
  /** Directory paths to include recursively */
  roots: string[];
}

/** Root directory exclusion */
export interface RootExcludeRule extends SelectionRuleBase {
  type: 'root-exclude';
  /** Directory paths to exclude recursively */
  roots: string[];
}

/** Selection cap/limit */
export interface CapRule extends SelectionRuleBase {
  type: 'cap';
  /** Maximum number of files in materialized selection */
  maxCount: number;
  /** Strategy when cap exceeded */
  strategy: 'first' | 'last' | 'random' | 'priority';
}

/** Union of all rule types */
export type SelectionRule =
  | ExplicitRule
  | GlobIncludeRule
  | GlobExcludeRule
  | RootIncludeRule
  | RootExcludeRule
  | CapRule;

/** Complete rule set for a folder context */
export interface SelectionRuleSet {
  /** Schema version for migrations */
  version: typeof SELECTION_RULES_SCHEMA_VERSION;
  /** Associated folder ID (workspace context) */
  folderId: string;
  /** Ordered list of rules */
  rules: SelectionRule[];
  /** Metadata */
  metadata: {
    createdAt: string;
    updatedAt: string;
    /** Source of migration (if migrated from v0) */
    migratedFrom?: 'explicit-set';
  };
}

/** Result of materializing a rule set */
export interface MaterializedSelection {
  /** Final set of selected file paths */
  paths: Set<string>;
  /** Rules that contributed to the selection */
  appliedRules: string[];
  /** Whether cap was applied */
  capped: boolean;
  /** Original count before cap */
  originalCount: number;
  /** Any warnings during materialization */
  warnings: string[];
}
```

### Rule Precedence

Rules are evaluated in the following order:

```
┌────────────────────────────────────────────────────────────┐
│                    RULE PRECEDENCE                         │
│                   (Highest to Lowest)                      │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  1. EXPLICIT (overrides)                                   │
│     └─ Individual paths always included/excluded           │
│                                                            │
│  2. GLOB-EXCLUDE                                           │
│     └─ Pattern-based exclusions                            │
│                                                            │
│  3. ROOT-EXCLUDE                                           │
│     └─ Directory tree exclusions                           │
│                                                            │
│  4. GLOB-INCLUDE                                           │
│     └─ Pattern-based inclusions                            │
│                                                            │
│  5. ROOT-INCLUDE                                           │
│     └─ Directory tree inclusions                           │
│                                                            │
│  6. CAP (post-processing)                                  │
│     └─ Limit applied after all other rules                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Evaluation Algorithm:**

1. Start with empty candidate set
2. Apply `root-include` rules → add matching files
3. Apply `glob-include` rules → add matching files
4. Apply `root-exclude` rules → remove matching files
5. Apply `glob-exclude` rules → remove matching files
6. Apply `explicit` rules → override (force include/exclude)
7. Apply `cap` rules → truncate if necessary

### Migration Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MIGRATION STRATEGY                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Phase 1: Dual-Write (Non-Breaking)                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • selectedFilePaths (Set<string>) remains primary                  │    │
│  │  • selectionRules (SelectionRuleSet) written in parallel            │    │
│  │  • Migration function converts Set → ExplicitRule                   │    │
│  │  • Consumers continue reading from Set                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Phase 2: Rule-First (Feature Flag)                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • New UI for creating glob/root rules                              │    │
│  │  • selectionRules becomes source of truth                           │    │
│  │  • selectedFilePaths materialized on demand                         │    │
│  │  • Feature flag: `useSelectionRulesV1`                              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Phase 3: Full Adoption                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  • Remove legacy Set-based storage                                  │    │
│  │  • All consumers use MaterializedSelection                          │    │
│  │  • Schema version bump triggers auto-migration                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Migration Function (v0 → v1):**

```typescript
function migrateExplicitSetToRuleSet(
  folderId: string,
  selectedFilePaths: Set<string>
): SelectionRuleSet {
  const paths: string[] = [];

  for (const compositeKey of selectedFilePaths) {
    const decoded = decodeFileSelection(compositeKey);
    if (decoded.folderId === folderId) {
      paths.push(decoded.path);
    }
  }

  return {
    version: SELECTION_RULES_SCHEMA_VERSION,
    folderId,
    rules: paths.length > 0 ? [{
      id: generateUUID(),
      type: 'explicit',
      paths,
      createdAt: new Date().toISOString(),
    }] : [],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      migratedFrom: 'explicit-set',
    },
  };
}
```

### Materialization Contract

Downstream consumers should expect the following from a materialized selection:

| Property | Guarantee |
|----------|-----------|
| **Determinism** | Same rules + same file tree = same output |
| **Immutability** | Materialized `paths` is a new Set on each call |
| **Folder-Scoped** | Paths are relative to the rule set's `folderId` |
| **No Composite Keys** | Paths are plain strings, not `folderId|@|path` |
| **Ordered** | Paths maintain consistent iteration order |
| **Capped** | If cap applied, `paths.size ≤ cap.maxCount` |

**Consumer API:**

```typescript
interface SelectionService {
  /** Get rule set for folder (creates default if missing) */
  getRuleSet(folderId: string): SelectionRuleSet;

  /** Materialize rules against a file tree */
  materialize(
    ruleSet: SelectionRuleSet,
    fileTree: IFileNode[]
  ): MaterializedSelection;

  /** Convert materialized selection to composite keys (legacy bridge) */
  toCompositeKeys(
    folderId: string,
    materialized: MaterializedSelection
  ): Set<string>;
}
```

## Consequences

### Positive

1. **Expressiveness**: Users can describe intent ("all TypeScript files") rather than enumerate
2. **Scalability**: Rules are O(1) storage; only file tree traversal is O(n)
3. **Composability**: Combine patterns with overrides naturally
4. **Auditability**: Rule history provides selection provenance
5. **Testability**: Pure functions for evaluation; deterministic output

### Negative

1. **Complexity**: More concepts to learn (rules, precedence, materialization)
2. **Migration Risk**: Dual-write period increases code paths
3. **Performance**: Glob matching on large trees may need optimization
4. **UI Changes**: New rule editing interface required

### Neutral

1. **Schema Versioning**: Standard practice but adds maintenance
2. **Feature Flags**: Added complexity during rollout

## Examples

### Example 1: TypeScript Project Selection

```typescript
const ruleSet: SelectionRuleSet = {
  version: 1,
  folderId: 'project-abc',
  rules: [
    {
      id: 'r1',
      type: 'glob-include',
      patterns: ['**/*.ts', '**/*.tsx'],
      createdAt: '2026-01-02T00:00:00Z',
    },
    {
      id: 'r2',
      type: 'root-exclude',
      roots: ['node_modules', 'dist', 'coverage'],
      createdAt: '2026-01-02T00:00:00Z',
    },
    {
      id: 'r3',
      type: 'cap',
      maxCount: 50,
      strategy: 'first',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ],
  metadata: {
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
};
```

### Example 2: Mixed with Explicit Override

```typescript
const ruleSet: SelectionRuleSet = {
  version: 1,
  folderId: 'project-xyz',
  rules: [
    // Include all source files
    {
      id: 'r1',
      type: 'root-include',
      roots: ['src'],
      createdAt: '2026-01-02T00:00:00Z',
    },
    // But exclude test files
    {
      id: 'r2',
      type: 'glob-exclude',
      patterns: ['**/*.test.ts', '**/*.spec.ts'],
      createdAt: '2026-01-02T00:00:00Z',
    },
    // Except this one important test (explicit override)
    {
      id: 'r3',
      type: 'explicit',
      paths: ['src/core/__tests__/critical.test.ts'],
      createdAt: '2026-01-02T00:00:00Z',
    },
  ],
  metadata: {
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
};
```

## References

- [ADR Best Practices](https://adr.github.io/) — ADR GitHub Organization
- [Microsoft Azure ADR Guidance](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record)
- [Nygard ADR Template](https://github.com/joelparkerhenderson/architecture-decision-record)
- [Zustand Persist Documentation](https://zustand.docs.pmnd.rs/integrations/persisting-store-data)
- `packages/file-explorer/AGENTS.md` — Current store architecture
- `packages/file-explorer/src/actions/file-selection-actions.ts` — Current selection actions
- `packages/types/src/file-explorer-types.ts` — Current type definitions

## Appendix: File References

| File | Purpose |
|------|---------|
| `packages/file-explorer/src/store.ts` | Zustand store factory |
| `packages/file-explorer/src/actions/file-selection-actions.ts` | Selection action creators |
| `packages/file-explorer/src/persistence/state-serialization.ts` | Set↔Array serialization |
| `packages/file-explorer-ui/src/use-file-tree-node-selection.ts` | UI selection hook |
| `packages/db-explorer/src/file-import/file-import-coordinator.ts` | Downstream consumer |
| `packages/file-import/src/enhanced-import.ts` | Downstream consumer |
