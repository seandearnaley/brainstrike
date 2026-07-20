import { MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import {
  projectFindWorkspaceSymbolModelOutput,
  projectLspInspectModelOutput,
} from '../../assistant-server/workspace-inspection-model-projections';

function serializedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

describe('workspace inspection model projections', () => {
  it('projects symbol matches as compact locations with honest LSP guidance', () => {
    const raw = {
      matches: [
        {
          declarationLine: 42,
          endLine: 58,
          name: 'export function resolveWorkspaceRoot(input: string) {',
          preview: [
            '41: /** Resolve one open root. */',
            '42: export function resolveWorkspaceRoot(input: string) {',
            '43:   return roots.get(input);',
          ].join('\n'),
          startLine: 42,
        },
      ],
      path: '/apps/desktop/src/assistant-server/workspace-roots.ts',
      rootName: 'brainstrike',
      totalMatches: 1,
      truncated: false,
    };

    const projected = projectFindWorkspaceSymbolModelOutput(raw);

    expect(projected.type).toBe('text');
    expect(projected.value).toContain(
      'symbols | root=brainstrike | path=/apps/desktop/src/assistant-server/workspace-roots.ts | shown=1/1 | truncated=false'
    );
    expect(projected.value).toContain('match declaration=42 | range=42-58');
    expect(projected.value).toContain(
      'declaration: export function resolveWorkspaceRoot(input: string) {'
    );
    expect(projected.value).toContain(
      'inspect: call brainstrike.lspInspect with the header root/path and one returned declaration line'
    );
    expect(projected.value).toContain(
      'place exactly one <<< immediately before the intended symbol in the returned declaration text'
    );
  });

  it('self-fits a maximum symbol page and makes omitted matches explicit', () => {
    const raw = {
      matches: Array.from({ length: 20 }, (_, index) => ({
        declarationLine: index * 20 + 1,
        endLine: index * 20 + 10,
        name: `export function generatedSymbol${index}${'x'.repeat(300)}() {`,
        preview: `${index * 20 + 1}: ${'preview '.repeat(180)}`,
        startLine: index * 20 + 1,
      })),
      path: `/src/${'nested/'.repeat(80)}generated.ts`,
      rootName: 'brainstrike',
      totalMatches: 50,
      truncated: true,
    };

    const projected = projectFindWorkspaceSymbolModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toMatch(/shown=\d+\/50 \| truncated=true/);
    expect(projected.value).toContain(
      'continue: reuse the prior brainstrike.findWorkspaceSymbol input with contextLines=0 and a narrower query; offset pagination is unavailable'
    );
    expect(projected.value).toContain('chars omitted]');
  });

  it('projects available LSP inspection without repeated JSON keys', () => {
    const raw = {
      available: true,
      definition: [
        {
          line: 21,
          path: '/src/definition.ts',
          preview: 'export const target = 1;',
        },
      ],
      diagnostics: [
        {
          character: 5,
          line: 9,
          message: 'Type mismatch',
          severity: 'error',
          source: 'ts',
        },
      ],
      hover: 'const target: number',
      implementation: [{ line: 88, path: '/src/implementation.ts' }],
      language: 'typescript',
      path: '/src/caller.ts',
      rootName: 'brainstrike',
    };

    const projected = projectLspInspectModelOutput(raw);

    expect(projected).toEqual({
      type: 'text',
      value: [
        'lsp | available=true | root=brainstrike | path=/src/caller.ts | language=typescript',
        'hover: const target: number',
        'diagnostic error 9:5 | source=ts | Type mismatch',
        'definition /src/definition.ts:21 | export const target = 1;',
        'implementation /src/implementation.ts:88',
      ].join('\n'),
    });
    expect(serializedChars(projected)).toBeLessThan(serializedChars(raw));
  });

  it('projects unavailable LSP inspection with its exact visible reason', () => {
    expect(
      projectLspInspectModelOutput({
        available: false,
        message: 'The TypeScript/JavaScript language server is unavailable.',
        path: '/src/caller.ts',
        reason: 'server-unavailable',
        rootName: 'brainstrike',
      })
    ).toEqual({
      type: 'text',
      value: [
        'lsp | available=false | root=brainstrike | path=/src/caller.ts | reason=server-unavailable',
        'message: The TypeScript/JavaScript language server is unavailable.',
      ].join('\n'),
    });
  });

  it('self-fits oversized LSP sections and reports projection omissions', () => {
    const raw = {
      available: true,
      definition: Array.from({ length: 10 }, (_, index) => ({
        line: index + 1,
        path: `/generated/definitions/${index}-${'d'.repeat(500)}.ts`,
        preview: 'definition preview '.repeat(40),
      })),
      diagnostics: Array.from({ length: 15 }, (_, index) => ({
        character: index + 1,
        line: index + 1,
        message: `diagnostic ${index} ${'m'.repeat(300)}`,
        severity: index % 2 === 0 ? 'error' : 'warning',
        source: 'typescript',
      })),
      hover: 'hover '.repeat(600),
      implementation: Array.from({ length: 10 }, (_, index) => ({
        line: index + 20,
        path: `/generated/implementations/${index}-${'i'.repeat(500)}.ts`,
        preview: 'implementation preview '.repeat(40),
      })),
      language: 'typescript',
      path: '/src/caller.ts',
      rootName: 'brainstrike',
    };

    const projected = projectLspInspectModelOutput(raw);

    expect(serializedChars(raw)).toBeGreaterThan(MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET);
    expect(serializedChars(projected)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projected.value).toContain('chars omitted]');
    expect(projected.value).toMatch(
      /projection_omitted: diagnostics=\d+, definitions=\d+, implementations=\d+/
    );
  });

  it('throws visibly for malformed or incoherent producer results', () => {
    expect(() =>
      projectFindWorkspaceSymbolModelOutput({
        matches: [],
        path: '/src/a.ts',
        rootName: 'brainstrike',
        totalMatches: -1,
        truncated: false,
      })
    ).toThrow('findWorkspaceSymbol model projection received a malformed result');

    expect(() =>
      projectLspInspectModelOutput({
        available: true,
        definition: [{ line: 0, path: '/src/a.ts' }],
        path: '/src/caller.ts',
        rootName: 'brainstrike',
      })
    ).toThrow('lspInspect model projection received a malformed result');
  });
});
