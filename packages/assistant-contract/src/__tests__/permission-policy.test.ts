import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICIES,
  InvalidPermissionPolicyError,
  isPermissionDecision,
  type PermissionDecisionInput,
  type PermissionPolicies,
  resolvePermissionDecision,
} from '../permission-policy';
import type { ToolRiskCategory } from '../tool-risk';

const ALL_CATEGORIES: readonly ToolRiskCategory[] = ['read', 'edit', 'execute', 'mcp'];

function makeInput(overrides: Partial<PermissionDecisionInput> = {}): PermissionDecisionInput {
  return {
    riskCategory: 'edit',
    policies: { ...DEFAULT_PERMISSION_POLICIES },
    yolo: false,
    sessionGrants: new Set<ToolRiskCategory>(),
    ...overrides,
  };
}

describe('DEFAULT_PERMISSION_POLICIES', () => {
  it('allows read and asks for edit/execute/mcp (safe-by-default)', () => {
    expect(DEFAULT_PERMISSION_POLICIES).toEqual({
      read: 'allow',
      edit: 'ask',
      execute: 'ask',
      mcp: 'ask',
    });
  });

  it('covers every risk category (total record)', () => {
    for (const category of ALL_CATEGORIES) {
      expect(DEFAULT_PERMISSION_POLICIES[category]).toBeDefined();
    }
  });
});

describe('isPermissionDecision', () => {
  it('accepts the three valid decisions', () => {
    for (const value of ['allow', 'ask', 'deny']) {
      expect(isPermissionDecision(value)).toBe(true);
    }
  });

  it('rejects unknown / malformed values', () => {
    for (const value of ['ALLOW', 'prompt', '', undefined, null, 1, {}]) {
      expect(isPermissionDecision(value)).toBe(false);
    }
  });
});

describe('resolvePermissionDecision', () => {
  it('returns the category policy by default (defaults: read allow, edit ask)', () => {
    expect(resolvePermissionDecision(makeInput({ riskCategory: 'read' }))).toBe('allow');
    expect(resolvePermissionDecision(makeInput({ riskCategory: 'edit' }))).toBe('ask');
    expect(resolvePermissionDecision(makeInput({ riskCategory: 'execute' }))).toBe('ask');
    expect(resolvePermissionDecision(makeInput({ riskCategory: 'mcp' }))).toBe('ask');
  });

  it('YOLO resolves every category to allow, overriding deny/ask/override/grant', () => {
    const denyAll: PermissionPolicies = {
      read: 'deny',
      edit: 'deny',
      execute: 'deny',
      mcp: 'deny',
    };
    for (const category of ALL_CATEGORIES) {
      const decision = resolvePermissionDecision(
        makeInput({
          riskCategory: category,
          yolo: true,
          policies: denyAll,
          perToolOverrides: { 'some.tool': 'deny' },
          toolId: 'some.tool',
        })
      );
      expect(decision).toBe('allow');
    }
  });

  it('keeps deny as deny unless YOLO, a grant, or an override changes it', () => {
    const policies: PermissionPolicies = { ...DEFAULT_PERMISSION_POLICIES, execute: 'deny' };
    expect(resolvePermissionDecision(makeInput({ riskCategory: 'execute', policies }))).toBe(
      'deny'
    );
  });

  it('promotes ask -> allow for a session-granted category only', () => {
    const grants = new Set<ToolRiskCategory>(['edit']);
    expect(
      resolvePermissionDecision(makeInput({ riskCategory: 'edit', sessionGrants: grants }))
    ).toBe('allow');
    // Other categories are unaffected by the edit grant.
    expect(
      resolvePermissionDecision(makeInput({ riskCategory: 'execute', sessionGrants: grants }))
    ).toBe('ask');
  });

  it('promotes deny -> allow for a session-granted category', () => {
    const policies: PermissionPolicies = { ...DEFAULT_PERMISSION_POLICIES, mcp: 'deny' };
    const grants = new Set<ToolRiskCategory>(['mcp']);
    expect(
      resolvePermissionDecision(makeInput({ riskCategory: 'mcp', policies, sessionGrants: grants }))
    ).toBe('allow');
  });

  it('lets a per-tool override beat the category policy (allow a normally-ask category)', () => {
    expect(
      resolvePermissionDecision(
        makeInput({
          riskCategory: 'edit',
          toolId: 'brainstrike.trustedWrite',
          perToolOverrides: { 'brainstrike.trustedWrite': 'allow' },
        })
      )
    ).toBe('allow');
  });

  it('lets a per-tool override deny a tool whose category is allow', () => {
    expect(
      resolvePermissionDecision(
        makeInput({
          riskCategory: 'read',
          toolId: 'brainstrike.secretRead',
          perToolOverrides: { 'brainstrike.secretRead': 'deny' },
        })
      )
    ).toBe('deny');
  });

  it('per-tool override beats a session grant (override has higher precedence)', () => {
    // Grant would promote edit -> allow, but the override denies this one tool.
    expect(
      resolvePermissionDecision(
        makeInput({
          riskCategory: 'edit',
          sessionGrants: new Set<ToolRiskCategory>(['edit']),
          toolId: 'brainstrike.dangerousEdit',
          perToolOverrides: { 'brainstrike.dangerousEdit': 'deny' },
        })
      )
    ).toBe('deny');
  });

  it('ignores overrides for a different tool id (falls through to the category policy)', () => {
    expect(
      resolvePermissionDecision(
        makeInput({
          riskCategory: 'edit',
          toolId: 'brainstrike.otherTool',
          perToolOverrides: { 'brainstrike.trustedWrite': 'allow' },
        })
      )
    ).toBe('ask');
  });

  it('throws InvalidPermissionPolicyError for an unknown category policy value (no silent fallback)', () => {
    const malformed = {
      ...DEFAULT_PERMISSION_POLICIES,
      execute: 'prompt',
    } as unknown as PermissionPolicies;
    expect(() =>
      resolvePermissionDecision(makeInput({ riskCategory: 'execute', policies: malformed }))
    ).toThrow(InvalidPermissionPolicyError);
  });

  it('throws when a category is missing from the policy record', () => {
    const missing = {
      read: 'allow',
      edit: 'ask',
      execute: 'ask',
      // mcp intentionally omitted
    } as unknown as PermissionPolicies;
    expect(() =>
      resolvePermissionDecision(makeInput({ riskCategory: 'mcp', policies: missing }))
    ).toThrow(InvalidPermissionPolicyError);
  });

  it('throws for a malformed per-tool override value rather than coercing it', () => {
    const overrides = { 'brainstrike.tool': 'maybe' } as unknown as Record<string, never>;
    expect(() =>
      resolvePermissionDecision(
        makeInput({
          riskCategory: 'edit',
          toolId: 'brainstrike.tool',
          perToolOverrides: overrides as never,
        })
      )
    ).toThrow(InvalidPermissionPolicyError);
  });

  it('surfaces the offending category and value on the thrown error', () => {
    const malformed = {
      ...DEFAULT_PERMISSION_POLICIES,
      mcp: 'nope',
    } as unknown as PermissionPolicies;
    try {
      resolvePermissionDecision(makeInput({ riskCategory: 'mcp', policies: malformed }));
      expect.unreachable('expected resolvePermissionDecision to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPermissionPolicyError);
      const typed = error as InvalidPermissionPolicyError;
      expect(typed.riskCategory).toBe('mcp');
      expect(typed.value).toBe('nope');
      expect(typed.message).toContain('mcp');
    }
  });
});
