import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract/tool-metadata';
import { describe, expect, it } from 'vitest';
import {
  allowedBySnapshot,
  applyLiveApprovalGate,
  createApprovalGate,
  resolveRequireToolApproval,
} from '../approval-gate';
import type { PermissionAskToolMetadata } from '../../permissions/permission-tool-gate';

const NAME_MAP = new Map([
  ['brainstrike_grepSearch', 'brainstrike.grepSearch'],
  ['brainstrike_writeWorkspaceFile', 'brainstrike.writeWorkspaceFile'],
  ['updateWorkingMemory', 'updateWorkingMemory'],
]);
const ASK_READ_AND_EDIT: ReadonlyMap<string, PermissionAskToolMetadata> = new Map([
  ['brainstrike_grepSearch', { originalName: 'brainstrike.grepSearch', riskCategory: 'read' }],
  [
    'brainstrike_writeWorkspaceFile',
    { originalName: 'brainstrike.writeWorkspaceFile', riskCategory: 'edit' },
  ],
]);
const READ_GRANT: PermissionToolGateSnapshot = {
  policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
  riskByTool: {
    'brainstrike.grepSearch': 'read',
    'brainstrike.writeWorkspaceFile': 'edit',
  },
  sessionGrants: ['read'],
  yolo: false,
};

function gate(remembered: PermissionToolGateSnapshot | undefined) {
  return createApprovalGate({
    askTools: ASK_READ_AND_EDIT,
    permissionEnforced: true,
    remembered: () => remembered,
    toolNameMap: NAME_MAP,
  });
}

describe('createApprovalGate', () => {
  it('gates exactly the ask set when nothing is remembered', () => {
    const live = gate(undefined);
    expect(live.gated).toBe(true);
    expect(live.requiresApproval({ toolName: 'brainstrike_grepSearch' })).toBe(true);
    expect(live.requiresApproval({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(true);
    expect(live.requiresApproval({ toolName: 'brainstrike_readWorkspaceFile' })).toBe(false);
  });

  it('never gates a Mastra-internal memory tool', () => {
    expect(gate(undefined).requiresApproval({ toolName: 'updateWorkingMemory' })).toBe(false);
  });

  it('lifts the gate for every tool a remembered session grant allows, and only those', () => {
    // MUTATION: a predicate that ignores `remembered` (returns `askTools.has`)
    // fails the first assertion — the row the live-app verifier counts as a
    // card after the grant (70 cards on the GLM run, 2026-09-15).
    const live = gate(READ_GRANT);
    expect(live.requiresApproval({ toolName: 'brainstrike_grepSearch' })).toBe(false);
    // Categories never cross: a read grant leaves the edit gate in place.
    expect(live.requiresApproval({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(true);
  });

  it('reads `remembered` on EVERY call, not once at construction', () => {
    let remembered: PermissionToolGateSnapshot | undefined;
    const live = createApprovalGate({
      askTools: ASK_READ_AND_EDIT,
      permissionEnforced: true,
      remembered: () => remembered,
      toolNameMap: NAME_MAP,
    });
    expect(live.requiresApproval({ toolName: 'brainstrike_grepSearch' })).toBe(true);
    remembered = READ_GRANT;
    expect(live.requiresApproval({ toolName: 'brainstrike_grepSearch' })).toBe(false);
  });

  it('is not gated when the ask set is empty', () => {
    const live = createApprovalGate({
      askTools: new Map(),
      permissionEnforced: true,
      remembered: () => undefined,
      toolNameMap: NAME_MAP,
    });
    expect(live.gated).toBe(false);
    expect(live.requiresApproval({ toolName: 'brainstrike_grepSearch' })).toBe(false);
  });
});

describe('allowedBySnapshot', () => {
  it('resolves the ORIGINAL name through the tool name map; an unregistered name is never allowed', () => {
    const allows = allowedBySnapshot(READ_GRANT, NAME_MAP);
    expect(allows('brainstrike_grepSearch')).toBe(true);
    expect(allows('brainstrike_writeWorkspaceFile')).toBe(false);
    expect(allows('brainstrike_notRegistered')).toBe(false);
  });
});

describe('resolveRequireToolApproval', () => {
  const gated = gate(undefined);
  const ungated = createApprovalGate({
    askTools: new Map(),
    permissionEnforced: false,
    remembered: () => undefined,
    toolNameMap: NAME_MAP,
  });

  it('hands Mastra the live predicate when the run has ask tools and the caller set nothing', () => {
    expect(resolveRequireToolApproval(undefined, gated, true)).toBe(gated.requiresApproval);
  });

  it('hands Mastra nothing when the run has no ask tools and the caller set nothing (parallel tool calls stay parallel)', () => {
    expect(resolveRequireToolApproval(undefined, ungated, false)).toBeUndefined();
    expect(resolveRequireToolApproval(undefined, ungated, true)).toBeUndefined();
  });

  it('turns an explicit GLOBAL request (no policy enforced, empty ask set) into a gate on every non-internal tool', () => {
    const resolved = resolveRequireToolApproval(true, ungated, false);
    expect(typeof resolved).toBe('function');
    if (typeof resolved !== 'function') {
      throw new Error('expected a predicate');
    }
    expect(resolved({ toolName: 'brainstrike_grepSearch' })).toBe(true);
    expect(resolved({ toolName: 'updateWorkingMemory' })).toBe(false);
  });

  it('keeps the all-allowed posture (policy enforced, empty ask set) gating nothing on an approval leg', () => {
    const allAllowed = createApprovalGate({
      askTools: new Map(),
      permissionEnforced: true,
      remembered: () => undefined,
      toolNameMap: NAME_MAP,
    });
    const resolved = resolveRequireToolApproval(true, allAllowed, true);
    expect(resolved).toBe(allAllowed.requiresApproval);
    expect(allAllowed.requiresApproval({ toolName: 'brainstrike_writeWorkspaceFile' })).toBe(false);
  });

  it('substitutes the live predicate for `true` on a policy-gated approval leg', () => {
    expect(resolveRequireToolApproval(true, gated, true)).toBe(gated.requiresApproval);
  });

  it('passes a caller-supplied function or `false` through unchanged', () => {
    const custom = () => true;
    expect(resolveRequireToolApproval(custom, gated, true)).toBe(custom);
    expect(resolveRequireToolApproval(false, gated, true)).toBe(false);
  });
});

describe('applyLiveApprovalGate', () => {
  class ToolLike {
    readonly id: string;
    constructor(id: string) {
      this.id = id;
    }
  }
  const askIds = new Set(['brainstrike_grepSearch', 'brainstrike_writeWorkspaceFile']);

  it('clones every ask tool with the FUNCTION form of `requireApproval` and leaves the rest by reference', async () => {
    const grep = new ToolLike('brainstrike.grepSearch');
    const read = new ToolLike('brainstrike.readWorkspaceFile');
    const tools = { brainstrike_grepSearch: grep, brainstrike_readWorkspaceFile: read };
    const gated = applyLiveApprovalGate(
      tools,
      new Set(['brainstrike_grepSearch']),
      gate(undefined)
    );
    expect(gated.brainstrike_readWorkspaceFile).toBe(read);
    expect(gated.brainstrike_grepSearch).not.toBe(grep);
    // The clone keeps the prototype and own fields; the input is untouched.
    expect(gated.brainstrike_grepSearch).toBeInstanceOf(ToolLike);
    expect((gated.brainstrike_grepSearch as ToolLike).id).toBe('brainstrike.grepSearch');
    expect((grep as { requireApproval?: unknown }).requireApproval).toBeUndefined();
    const flag = (gated.brainstrike_grepSearch as { requireApproval?: unknown }).requireApproval;
    expect(typeof flag).toBe('function');
    if (typeof flag !== 'function') {
      throw new Error('expected the function-form flag');
    }
    expect(await flag({}, {})).toBe(true);
  });

  it('the clone reads the gate on EVERY call: a grant remembered later lifts it', async () => {
    // MUTATION: a clone that captures the decision at clone time (or ignores
    // `remembered`) keeps returning true — the harness row "after a live
    // session grant the sibling's NEXT gated read runs without a pause" fails.
    let remembered: PermissionToolGateSnapshot | undefined;
    const live = createApprovalGate({
      askTools: ASK_READ_AND_EDIT,
      permissionEnforced: true,
      remembered: () => remembered,
      toolNameMap: NAME_MAP,
    });
    const gated = applyLiveApprovalGate(
      {
        brainstrike_grepSearch: new ToolLike('brainstrike.grepSearch'),
        brainstrike_writeWorkspaceFile: new ToolLike('brainstrike.writeWorkspaceFile'),
      },
      askIds,
      live
    );
    const flagOf = (name: keyof typeof gated) =>
      (gated[name] as unknown as { requireApproval: (input: unknown, ctx: unknown) => boolean })
        .requireApproval;
    expect(flagOf('brainstrike_grepSearch')({}, {})).toBe(true);
    remembered = READ_GRANT;
    expect(flagOf('brainstrike_grepSearch')({}, {})).toBe(false);
    // A read grant never lifts an edit gate.
    expect(flagOf('brainstrike_writeWorkspaceFile')({}, {})).toBe(true);
  });

  it('refuses an ask id that is not in the map (a kept ask tool must never be missed)', () => {
    expect(() =>
      applyLiveApprovalGate({}, new Set(['brainstrike_grepSearch']), gate(undefined))
    ).toThrow(/brainstrike_grepSearch/);
  });
});
