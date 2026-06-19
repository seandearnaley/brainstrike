/**
 * Permission Policy contract + decision resolver (permission engine, step 2/4).
 *
 * Builds ON the {@link ToolRiskCategory} taxonomy (tool-risk.ts): a tool's risk
 * bucket is the KEY into the user's per-category permission policy. This module
 * holds the PURE decision logic and the shared types only — there is NO zustand
 * store, NO DOM, and NO enforcement wired into any runtime here. Enforcement
 * into the Mastra loop is a later step (PR-1.3); the approval UI is later still
 * (PR-1.4).
 *
 * The store that PERSISTS these policies lives in `@brainstrike/preferences`
 * (`permission-policy-store.ts`); it imports the types and resolver from here so
 * the resolver can be unit-tested without zustand and reused identically in web
 * and Electron.
 */

import type { ToolRiskCategory } from './tool-risk.js';

/**
 * A SERIALIZABLE snapshot of the permission posture plus the caller-provided
 * tool risk classification, threaded into the agent runtime so it can gate the
 * tool map BEFORE the (immutable) Mastra `Agent` is constructed (permission
 * engine, step 3/4).
 *
 * Serializable by design: it crosses the runtime/IPC boundary, so `sessionGrants`
 * is an ARRAY (not the resolver's `ReadonlySet`) and every field is a plain JSON
 * value. The runtime gate adapts the array to a `Set` internally before calling
 * {@link resolvePermissionDecision}.
 *
 * Risk classification is CALLER-PROVIDED: the registry that assembles the tool
 * map owns `riskByTool` (keyed by tool id). The runtime gate must NOT introspect
 * Mastra tool objects for brainstrike risk metadata — that metadata is
 * registry-side and never rides on the Mastra tool instance.
 */
export interface PermissionToolGateSnapshot {
  /**
   * Risk for a tool absent from {@link riskByTool} (e.g. a discovered MCP tool).
   * Defaults to `'mcp'` (most restrictive sensible) in the runtime gate when
   * omitted, so an unclassified tool is never treated as harmless `'read'`.
   */
  defaultRisk?: ToolRiskCategory;
  /** Optional per-tool-id override map; an entry beats the category policy. */
  perToolOverrides?: PerToolPermissionOverrides;
  /** Per-risk-category decision policy. */
  policies: PermissionPolicies;
  /**
   * Caller-provided tool-id → risk classification. Looked up by original tool
   * name first, then by sanitized id, before falling back to {@link defaultRisk}.
   */
  riskByTool?: Record<string, ToolRiskCategory>;
  /**
   * Categories granted "always allow for this session". Array (serializable);
   * the gate adapts it to a `ReadonlySet` for the resolver.
   */
  sessionGrants?: ToolRiskCategory[];
  /** Master "allow everything" toggle. */
  yolo: boolean;
}

/**
 * The outcome of evaluating a tool call against the permission policy.
 * - `allow`: run the tool without prompting.
 * - `ask`: prompt the user for approval before running.
 * - `deny`: refuse the tool call outright.
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * The full set of valid {@link PermissionDecision} values, for runtime
 * validation. A persisted policy value outside this set is malformed and MUST
 * throw rather than be silently coerced (no-silent-fallbacks).
 */
export const PERMISSION_DECISIONS: readonly PermissionDecision[] = [
  'allow',
  'ask',
  'deny',
] as const;

/**
 * Per-risk-category policy: how to treat a tool call whose risk bucket is the
 * key. Every {@link ToolRiskCategory} MUST have a decision (the type is a total
 * record), so the resolver never faces a missing category at compile time.
 */
export type PermissionPolicies = Record<ToolRiskCategory, PermissionDecision>;

/**
 * Optional per-tool-id override map. A present entry for a given tool id beats
 * the category policy for that one tool (see precedence in
 * {@link resolvePermissionDecision}). Mastra-code's policy type carries this
 * field but never ships it; we do.
 */
export type PerToolPermissionOverrides = Record<string, PermissionDecision>;

/**
 * Default per-category policy. Read is harmless, so it is allowed outright;
 * everything that can mutate, execute, or delegate to an opaque MCP server asks
 * first. This is the safe-by-default posture the permission engine ships with.
 */
export const DEFAULT_PERMISSION_POLICIES: PermissionPolicies = {
  read: 'allow',
  edit: 'ask',
  execute: 'ask',
  mcp: 'ask',
};

/**
 * Thrown when a permission policy value is malformed — i.e. the policy record is
 * missing the requested risk category, or holds a value that is not a valid
 * {@link PermissionDecision}.
 *
 * Per the project no-silent-fallbacks rule, a malformed policy is a programming
 * or persistence error and MUST surface, never be quietly coerced to a default
 * such as `'ask'`.
 */
export class InvalidPermissionPolicyError extends Error {
  readonly riskCategory: ToolRiskCategory;
  readonly value: unknown;

  constructor(riskCategory: ToolRiskCategory, value: unknown) {
    super(
      `Invalid permission policy for risk category '${riskCategory}': ` +
        `expected one of ${PERMISSION_DECISIONS.join(' | ')}, received ${formatValue(value)}. ` +
        'A malformed policy must never be silently coerced to a default decision.'
    );
    this.name = 'InvalidPermissionPolicyError';
    this.riskCategory = riskCategory;
    this.value = value;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (value === undefined) {
    return 'undefined';
  }
  return String(value);
}

/**
 * Narrowing guard for a single {@link PermissionDecision} value.
 */
export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

/**
 * Inputs to {@link resolvePermissionDecision}. The store supplies these; the
 * resolver itself owns no state.
 */
export interface PermissionDecisionInput {
  /** Optional per-tool override map (persisted); beats the category policy. */
  perToolOverrides?: PerToolPermissionOverrides;
  /** The category policy map (persisted). */
  policies: PermissionPolicies;
  /** Risk bucket of the tool being evaluated (the category-policy key). */
  riskCategory: ToolRiskCategory;
  /**
   * Categories the user has granted "always allow for this session". Session
   * grants are session-lived (NOT persisted) and promote `'ask'`/`'deny'` to
   * `'allow'` for that category only.
   */
  sessionGrants: ReadonlySet<ToolRiskCategory>;
  /** Optional tool id, used to look up a {@link perToolOverrides} entry. */
  toolId?: string;
  /** Master "allow everything" toggle (persisted). */
  yolo: boolean;
}

/**
 * Resolve the permission decision for a single tool call.
 *
 * PRECEDENCE (highest first):
 * 1. YOLO — if `yolo` is true, the decision is `'allow'` unconditionally.
 * 2. Per-tool override — if `toolId` has an entry in `perToolOverrides`, that
 *    decision wins (it can `'deny'` a tool whose category is `'allow'`, or
 *    `'allow'` a tool whose category is `'ask'`). A malformed override value
 *    throws.
 * 3. Session grant — if the category is in `sessionGrants`, the decision is
 *    `'allow'` (promotes an `'ask'` or `'deny'` category for this session only).
 * 4. Category policy — otherwise the persisted per-category decision. A missing
 *    or malformed category value throws {@link InvalidPermissionPolicyError}.
 *
 * STRICT: an unknown/missing policy or override value THROWS — it is never
 * silently coerced to `'ask'` (no-silent-fallbacks).
 */
export function resolvePermissionDecision(input: PermissionDecisionInput): PermissionDecision {
  const { riskCategory, policies, yolo, sessionGrants, toolId, perToolOverrides } = input;

  // 1. YOLO wins over everything.
  if (yolo) {
    return 'allow';
  }

  // 2. Per-tool override beats the category policy (allow OR deny).
  if (toolId !== undefined && perToolOverrides) {
    const override = perToolOverrides[toolId];
    if (override !== undefined) {
      if (!isPermissionDecision(override)) {
        throw new InvalidPermissionPolicyError(riskCategory, override);
      }
      return override;
    }
  }

  // 3. A session grant promotes this category to 'allow' for this session only.
  if (sessionGrants.has(riskCategory)) {
    return 'allow';
  }

  // 4. Fall back to the persisted category policy — strictly validated.
  const policy = policies[riskCategory];
  if (!isPermissionDecision(policy)) {
    throw new InvalidPermissionPolicyError(riskCategory, policy);
  }
  return policy;
}
