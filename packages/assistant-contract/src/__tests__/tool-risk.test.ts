import { describe, expect, it } from 'vitest';
import {
  buildNativeToolRiskMap,
  NATIVE_TOOL_DEFAULTS,
  type NativeToolDefaultMetadata,
} from '../tool-categories';
import {
  resolveToolRiskCategory,
  type ToolRiskCategory,
  type ToolRiskMetadata,
  UndeterminableToolRiskError,
} from '../tool-risk';

describe('resolveToolRiskCategory', () => {
  it('returns the explicitly declared riskCategory unconditionally (declared wins)', () => {
    const declared: ToolRiskMetadata = {
      // A category/approval combo that WOULD otherwise derive to 'read'...
      category: 'retrieval',
      requiresApproval: false,
      // ...but the explicit declaration overrides the heuristic.
      riskCategory: 'execute',
    };
    expect(resolveToolRiskCategory(declared)).toBe('execute');
  });

  it("derives 'read' for an unambiguously read-only tool (read-derivable category + no approval)", () => {
    for (const category of ['retrieval', 'analysis', 'validation'] as const) {
      expect(resolveToolRiskCategory({ category, requiresApproval: false })).toBe('read');
    }
  });

  it('throws for a mutating tool that does not declare a riskCategory (no silent fallback)', () => {
    expect(() => resolveToolRiskCategory({ category: 'action', requiresApproval: true })).toThrow(
      UndeterminableToolRiskError
    );
  });

  it('throws when requiresApproval is true even for a read-derivable category', () => {
    // requiresApproval gates derivation: an approval-required retrieval tool is
    // ambiguous and must declare its risk explicitly.
    expect(() =>
      resolveToolRiskCategory({ category: 'retrieval', requiresApproval: true })
    ).toThrow(UndeterminableToolRiskError);
  });

  it('throws for a non-read-derivable category even without approval', () => {
    for (const category of ['action', 'configuration'] as const) {
      expect(() => resolveToolRiskCategory({ category, requiresApproval: false })).toThrow(
        UndeterminableToolRiskError
      );
    }
  });

  it('surfaces the offending metadata on the thrown error', () => {
    try {
      resolveToolRiskCategory({ category: 'configuration', requiresApproval: true });
      expect.unreachable('expected resolveToolRiskCategory to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UndeterminableToolRiskError);
      const typed = error as UndeterminableToolRiskError;
      expect(typed.category).toBe('configuration');
      expect(typed.requiresApproval).toBe(true);
      expect(typed.message).toContain('riskCategory');
    }
  });

  describe('every current native tool resolves without throwing', () => {
    const entries = Object.entries(NATIVE_TOOL_DEFAULTS) as [string, NativeToolDefaultMetadata][];

    it.each(entries)('%s resolves to a known risk category', (_id, metadata) => {
      const resolved = resolveToolRiskCategory(metadata);
      expect(['read', 'edit', 'execute', 'mcp']).toContain(resolved);
    });

    it('classifies the approval-gated workspace mutators as edit (via explicit annotation)', () => {
      const editTools: readonly string[] = [
        'brainstrike.updateWorkspaceContextSelection',
        'brainstrike.updateWorkspaceTapestrySelections',
        'brainstrike.writeWorkspaceFile',
        'brainstrike.stringReplaceWorkspaceFile',
      ];
      for (const id of editTools) {
        const metadata = NATIVE_TOOL_DEFAULTS[id];
        if (!metadata) {
          expect.unreachable(`${id} should exist in NATIVE_TOOL_DEFAULTS`);
        }
        expect(resolveToolRiskCategory(metadata)).toBe('edit');
      }
    });

    it('classifies the shell tool as execute (via explicit annotation)', () => {
      const metadata = NATIVE_TOOL_DEFAULTS['brainstrike.executeCommand'];
      if (!metadata) {
        expect.unreachable('brainstrike.executeCommand should exist in NATIVE_TOOL_DEFAULTS');
      }
      expect(resolveToolRiskCategory(metadata)).toBe('execute');
    });

    it("classifies every other current native tool as 'read' (no throw)", () => {
      const explicitlyNonRead = new Set<string>([
        'brainstrike.updateWorkspaceContextSelection',
        'brainstrike.updateWorkspaceTapestrySelections',
        'brainstrike.writeWorkspaceFile',
        'brainstrike.stringReplaceWorkspaceFile',
        // The shell tool is the first 'execute'-risk native tool.
        'brainstrike.executeCommand',
      ]);
      const readTools = entries.filter(([id]) => !explicitlyNonRead.has(id));

      // Guard: every remaining native tool must be read-only. If a future tool
      // breaks this, update the explicitlyNonRead set above.
      expect(readTools.length).toBeGreaterThan(0);
      for (const [id, metadata] of readTools) {
        const resolved: ToolRiskCategory = resolveToolRiskCategory(metadata);
        expect(resolved, `${id} should resolve to 'read'`).toBe('read');
      }
    });
  });
});

describe('buildNativeToolRiskMap', () => {
  const EDIT_TOOLS: readonly string[] = [
    'brainstrike.updateWorkspaceContextSelection',
    'brainstrike.updateWorkspaceTapestrySelections',
    'brainstrike.writeWorkspaceFile',
    'brainstrike.stringReplaceWorkspaceFile',
  ];

  it('maps every native tool id to its resolved risk category', () => {
    const riskByTool = buildNativeToolRiskMap();
    const ids = Object.keys(NATIVE_TOOL_DEFAULTS);

    // Every tool is present and classified...
    expect(Object.keys(riskByTool).sort()).toEqual(ids.sort());
    for (const id of ids) {
      const metadata = NATIVE_TOOL_DEFAULTS[id];
      if (!metadata) {
        expect.unreachable(`${id} should exist in NATIVE_TOOL_DEFAULTS`);
      }
      // ...with the SAME category the pure resolver derives for it.
      expect(riskByTool[id]).toBe(resolveToolRiskCategory(metadata));
    }
  });

  it("classifies the approval-gated mutators as 'edit', the shell tool as 'execute', and the rest as 'read'", () => {
    const riskByTool = buildNativeToolRiskMap();

    for (const id of EDIT_TOOLS) {
      expect(riskByTool[id]).toBe('edit');
    }
    expect(riskByTool['brainstrike.executeCommand']).toBe('execute');

    const nonRead = new Set<string>([...EDIT_TOOLS, 'brainstrike.executeCommand']);
    const readTools = Object.keys(riskByTool).filter((id) => !nonRead.has(id));
    expect(readTools.length).toBeGreaterThan(0);
    for (const id of readTools) {
      expect(riskByTool[id], `${id} should be 'read'`).toBe('read');
    }
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const first = buildNativeToolRiskMap();
    const second = buildNativeToolRiskMap();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("classifies manageTaskList as 'read' so plan updates never suspend for approval", () => {
    // It is category:'action' (UI/load taxonomy) but mutates only the assistant's
    // own ephemeral todo list, so its risk bucket must stay 'read'.
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.manageTaskList']?.category).toBe('action');
    expect(NATIVE_TOOL_DEFAULTS['brainstrike.manageTaskList']?.requiresApproval).toBe(false);
    expect(buildNativeToolRiskMap()['brainstrike.manageTaskList']).toBe('read');
  });
});
