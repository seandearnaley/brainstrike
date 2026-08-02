/**
 * Server-side permission-policy request assembly (permission engine, step 4/4 —
 * the WIRE seam).
 *
 * The renderer persists the user's permission posture in the
 * `permission-policy-store` (@brainstrike/app-state) and attaches a
 * SERIALIZABLE snapshot of it to the assistant request — but ONLY when the
 * user's OPT-IN `enforce` flag is true. The renderer never classifies tool risk:
 * that mapping is registry-side (`buildNativeToolRiskMap`) and is built HERE,
 * server-side, so a client can never spoof a tool's risk bucket.
 *
 * This module turns the request-carried snapshot into the trusted
 * {@link PermissionToolGateSnapshot} the runtime gate consumes
 * (`filterToolsByPermissionWithMetadata`), or returns `undefined` when
 * enforcement is off so the runtime keeps its production-default passthrough (no
 * tools omitted).
 *
 * STRICT (no-silent-fallbacks): a malformed policy value is NOT validated or
 * coerced here — it rides through to the runtime resolver, which throws
 * `InvalidPermissionPolicyError`. We never silently drop or repair a bad policy.
 */

import {
  buildNativeToolRiskMap,
  type PermissionPolicies,
  type PermissionToolGateSnapshot,
  type PerToolPermissionOverrides,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';

/**
 * The default risk bucket for a tool absent from the server-built `riskByTool`
 * map (e.g. a discovered MCP tool). `'mcp'` is the most restrictive sensible
 * fallback, matching the runtime gate's own `FALLBACK_DEFAULT_RISK`, so an
 * unclassified tool is never treated as harmless `'read'` by accident.
 */
const REQUEST_DEFAULT_RISK: ToolRiskCategory = 'mcp';

/**
 * The permission snapshot the RENDERER serializes onto the assistant request.
 *
 * It mirrors the store's `PermissionToolGateSnapshotInput`: the persisted policy
 * posture plus the OPT-IN `enforce` flag, with `sessionGrants` as a plain array
 * so it crosses the renderer → server boundary as JSON. It deliberately omits
 * `riskByTool`/`defaultRisk` — tool risk classification is server-owned and is
 * added in {@link resolveRequestPermissionPolicy}.
 */
export interface AssistantPermissionPolicyRequest {
  /**
   * OPT-IN enforcement switch. When `false`/absent the renderer should not send
   * this object at all; even if it does, {@link resolveRequestPermissionPolicy}
   * returns `undefined` (passthrough) so the runtime omits nothing.
   */
  enforce?: boolean;
  perToolOverrides?: PerToolPermissionOverrides;
  policies?: PermissionPolicies;
  sessionGrants?: ToolRiskCategory[];
  yolo?: boolean;
}

/**
 * Type guard for the request-carried permission snapshot. Accepts any object
 * shape (the policy VALUES are validated strictly later by the runtime
 * resolver); it only confirms we were handed an object so we can read `enforce`.
 */
export function isAssistantPermissionPolicyRequest(
  value: unknown
): value is AssistantPermissionPolicyRequest {
  return typeof value === 'object' && value !== null;
}

/**
 * Build the trusted runtime gate snapshot from the request-carried permission
 * snapshot.
 *
 * - When `request` is absent, or its `enforce` flag is not strictly `true`,
 *   returns `undefined`. The caller MUST then leave `runtime.permissionPolicy`
 *   unset — this is the passthrough guarantee that preserves current behavior
 *   (no tools omitted) whenever the user has not opted in.
 * - When `enforce === true`, returns a {@link PermissionToolGateSnapshot} with
 *   the user's policies/yolo/sessionGrants/perToolOverrides AND a SERVER-built
 *   `riskByTool` (`buildNativeToolRiskMap()`) + `defaultRisk: 'mcp'`. The policy
 *   values are NOT pre-validated — a malformed value surfaces from the runtime
 *   resolver as `InvalidPermissionPolicyError` (propagated, never swallowed).
 *
 * `policies` is required for a meaningful gate; if `enforce` is true but
 * `policies` is missing the snapshot still carries an (empty) object and the
 * runtime resolver throws on the first tool — a loud failure, never a silent
 * allow.
 */
export function resolveRequestPermissionPolicy(
  request: AssistantPermissionPolicyRequest | undefined
): PermissionToolGateSnapshot | undefined {
  if (request?.enforce !== true) {
    return;
  }

  const snapshot: PermissionToolGateSnapshot = {
    defaultRisk: REQUEST_DEFAULT_RISK,
    policies: request.policies ?? ({} as PermissionPolicies),
    riskByTool: buildNativeToolRiskMap(),
    yolo: request.yolo ?? false,
    ...(request.sessionGrants ? { sessionGrants: request.sessionGrants } : {}),
    ...(request.perToolOverrides ? { perToolOverrides: request.perToolOverrides } : {}),
  };
  return snapshot;
}
