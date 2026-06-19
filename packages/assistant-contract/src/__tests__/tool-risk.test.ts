import { describe, expect, it } from 'vitest';
import { NATIVE_TOOL_DEFAULTS, type NativeToolDefaultMetadata } from '../tool-categories';
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

    it('classifies the two approval-gated workspace mutators as edit (via explicit annotation)', () => {
      const editTools: readonly string[] = [
        'brainstrike.updateWorkspaceContextSelection',
        'brainstrike.updateWorkspaceTapestrySelections',
      ];
      for (const id of editTools) {
        const metadata = NATIVE_TOOL_DEFAULTS[id];
        if (!metadata) {
          expect.unreachable(`${id} should exist in NATIVE_TOOL_DEFAULTS`);
        }
        expect(resolveToolRiskCategory(metadata)).toBe('edit');
      }
    });

    it("classifies every other current native tool as 'read' (no throw)", () => {
      const explicitlyEdited = new Set<string>([
        'brainstrike.updateWorkspaceContextSelection',
        'brainstrike.updateWorkspaceTapestrySelections',
      ]);
      const readTools = entries.filter(([id]) => !explicitlyEdited.has(id));

      // Guard: this PR predates any execute/mcp native tool, so the remainder
      // must all be read-only. If a future tool breaks this, update the test.
      expect(readTools.length).toBeGreaterThan(0);
      for (const [id, metadata] of readTools) {
        const resolved: ToolRiskCategory = resolveToolRiskCategory(metadata);
        expect(resolved, `${id} should resolve to 'read'`).toBe('read');
      }
    });
  });
});
