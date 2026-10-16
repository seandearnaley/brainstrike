/**
 * Server-side permission-policy WIRE assembly (PR-1.4a).
 *
 * `resolveRequestPermissionPolicy` (pure): the renderer-carried opt-in snapshot
 * → trusted `PermissionToolGateSnapshot`. `enforce:false`/absent → `undefined`
 * (passthrough); `enforce:true` → a snapshot with SERVER-built `riskByTool`
 * (`buildNativeToolRiskMap`) + `defaultRisk: 'mcp'`.
 *
 * This file used to carry a second layer: the resolved snapshot driven END TO
 * END through the Mastra agent loop, asserting that an `edit:'deny'` request
 * omitted the edit-risk tools from the live tool map. That loop is retired
 * (ADR-0022); the equivalent on the production path is the host's own
 * admission, and `filterToolsForPlanMode`'s sibling gate is exercised by
 * `apps/desktop/src/__tests__/host-live-native-tools.integration.test.ts`
 * against the real host loop.
 */
import { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import {
  type AssistantPermissionPolicyRequest,
  resolveRequestPermissionPolicy,
} from '../permissions/permission-policy-request';
import type { RuntimeData } from '../types';

// The two known edit mutators and one reader, named for the risk assertions.
const EDIT_TOOL_A = 'brainstrike.stringReplaceWorkspaceFile';
const EDIT_TOOL_B = 'brainstrike.writeWorkspaceFile';
const READ_TOOL = 'brainstrike.readWorkspaceFile';

describe('resolveRequestPermissionPolicy', () => {
  it('returns undefined when the request is absent (passthrough)', () => {
    expect(resolveRequestPermissionPolicy(undefined)).toBeUndefined();
  });

  it('returns undefined when enforce is false or absent (passthrough)', () => {
    expect(
      resolveRequestPermissionPolicy({
        enforce: false,
        policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      })
    ).toBeUndefined();
    expect(
      resolveRequestPermissionPolicy({
        policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      } as AssistantPermissionPolicyRequest)
    ).toBeUndefined();
  });

  it('builds a trusted snapshot with server-owned riskByTool + defaultRisk when enforce is true', () => {
    const snapshot = resolveRequestPermissionPolicy({
      enforce: true,
      perToolOverrides: { 'brainstrike.tool': 'allow' },
      policies: { edit: 'deny', execute: 'ask', mcp: 'allow', read: 'allow' },
      sessionGrants: ['execute'],
      yolo: false,
    });

    expect(snapshot).toBeDefined();
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    // Policy posture carried through verbatim...
    expect(snapshot.policies).toEqual({
      edit: 'deny',
      execute: 'ask',
      mcp: 'allow',
      read: 'allow',
    });
    expect(snapshot.yolo).toBe(false);
    expect(snapshot.sessionGrants).toEqual(['execute']);
    expect(snapshot.perToolOverrides).toEqual({ 'brainstrike.tool': 'allow' });
    // ...with the SERVER-built risk classification + restrictive default.
    expect(snapshot.riskByTool).toEqual(buildNativeToolRiskMap());
    expect(snapshot.defaultRisk).toBe('mcp');
    // The two known edit mutators classify as 'edit'.
    expect(snapshot.riskByTool?.[EDIT_TOOL_A]).toBe('edit');
    expect(snapshot.riskByTool?.[EDIT_TOOL_B]).toBe('edit');
    expect(snapshot.riskByTool?.[READ_TOOL]).toBe('read');
  });

  it('omits sessionGrants / perToolOverrides keys when not provided', () => {
    const snapshot = resolveRequestPermissionPolicy({
      enforce: true,
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
    });
    if (!snapshot) {
      expect.unreachable('snapshot must be defined when enforce is true');
    }
    expect('sessionGrants' in snapshot).toBe(false);
    expect('perToolOverrides' in snapshot).toBe(false);
  });
});

/**
 * Wire-shape contract for `RuntimeData['permissionPolicyRequest']` — the
 * RESOLVER half. Full rationale lives on the field declaration in `../types.ts`;
 * the PRODUCER half is pinned by "leaves the opt-in keys PRESENT with undefined
 * values" in
 * `packages/app-shell/src/__tests__/use-assistant-request-lifecycle.test.ts`.
 *
 * In short: the producer always writes the key, so consumers must read the
 * VALUE. These cases pin that the resolver cannot tell an absent key from an
 * explicit `undefined`, and that an opted-in snapshot survives serialization.
 */
describe('permissionPolicyRequest wire-shape contract (absent key vs explicit undefined)', () => {
  // Value type tracks `RuntimeData`, so a contract change breaks this test. The
  // indexed access already reads as `AssistantPermissionPolicyRequest |
  // undefined`, which is what lets this accept the producer's explicit
  // `undefined` under `exactOptionalPropertyTypes`.
  interface RuntimeDataFieldReader {
    permissionPolicyRequest?: RuntimeData['permissionPolicyRequest'];
  }

  const enforcing: AssistantPermissionPolicyRequest = {
    enforce: true,
    policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
  };

  const absentKey: RuntimeDataFieldReader = {};
  const explicitUndefined: RuntimeDataFieldReader = { permissionPolicyRequest: undefined };

  it('resolves the two opted-out shapes identically (passthrough)', () => {
    expect(resolveRequestPermissionPolicy(absentKey.permissionPolicyRequest)).toBeUndefined();
    expect(
      resolveRequestPermissionPolicy(explicitUndefined.permissionPolicyRequest)
    ).toBeUndefined();
  });

  it('still carries an opted-in snapshot across the JSON boundary', () => {
    // `JSON.parse(JSON.stringify(...))` models the renderer → server transport.
    // `structuredClone` is NOT a substitute anywhere in this contract: it
    // preserves undefined-valued keys, which is the very thing under test.
    const serialized = JSON.parse(
      JSON.stringify({ permissionPolicyRequest: enforcing } satisfies RuntimeDataFieldReader)
    ) as RuntimeDataFieldReader;

    const snapshot = resolveRequestPermissionPolicy(serialized.permissionPolicyRequest);

    // Round-trip fidelity only — `defaultRisk` and the rest of the resolver's
    // output are covered by the `resolveRequestPermissionPolicy` suite above.
    expect(snapshot?.policies).toEqual(enforcing.policies);
  });
});
