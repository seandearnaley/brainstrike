import { describe, expect, it } from 'vitest';
import {
  buildContextBudgetNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
} from '../default-instructions';

describe('default assistant instructions', () => {
  it('exports a focused builder that protects Brainstrike context-tool guidance', () => {
    const toolNameMap = new Map<string, string>([
      ['brainstrike_listWorkspaceContext', 'brainstrike.listWorkspaceContext'],
      ['brainstrike_listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
      ['brainstrike_queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
      ['brainstrike_readWorkspaceContext', 'brainstrike.readWorkspaceContext'],
      ['brainstrike_readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
      [
        'brainstrike_updateWorkspaceContextSelection',
        'brainstrike.updateWorkspaceContextSelection',
      ],
      [
        'brainstrike_updateWorkspaceTapestrySelections',
        'brainstrike.updateWorkspaceTapestrySelections',
      ],
    ]);

    const instructions = buildDefaultInstructions(toolNameMap);

    expect(instructions).toContain('Brainstrike IDE');
    expect(instructions).toContain('brainstrike_listWorkspaceContext');
    expect(instructions).toContain('brainstrike_listEmbeddingSpaces');
    expect(instructions).toContain('brainstrike_queryEmbeddingSpace');
    expect(instructions).toContain('without embeddingSetId so it uses the Workspace Index');
    expect(instructions).toContain('semantic chunks with persisted source line ranges');
    expect(instructions).toContain('Only run state-changing tools after the user confirms.');
    expect(instructions).not.toContain('brainstrike.listWorkspaceContext');
  });

  it('keeps the built-in local instruction set compact and tool-name-aware', () => {
    const toolNameMap = new Map<string, string>([
      ['brainstrike_grepSearch', 'brainstrike.grepSearch'],
      ['brainstrike_queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
      ['brainstrike_readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
    ]);

    const localInstructions = buildLocalDefaultInstructions(toolNameMap);
    const hostedInstructions = buildDefaultInstructions(toolNameMap);

    expect(localInstructions).toContain('running fully on this device');
    expect(localInstructions).toContain('brainstrike_grepSearch');
    expect(localInstructions).toContain('brainstrike_queryEmbeddingSpace');
    expect(localInstructions).toContain('brainstrike_readWorkspaceFile');
    expect(localInstructions).toContain('Only run state-changing tools after the user confirms.');
    // A 2B on-device model must not get the hosted playbook: keep the local
    // prompt a small fraction of it (also keeps the WebGPU prefill short).
    expect(localInstructions.length).toBeLessThan(hostedInstructions.length / 3);

    const withoutSearchTools = buildLocalDefaultInstructions(new Map());
    expect(withoutSearchTools).not.toContain('brainstrike_grepSearch');
    expect(withoutSearchTools).toContain('running fully on this device');
  });

  it('does not advertise unavailable native tools', () => {
    const instructions = buildDefaultInstructions(
      new Map<string, string>([['brainstrike_readWorkspaceFile', 'brainstrike.readWorkspaceFile']])
    );

    expect(instructions).toContain('brainstrike_readWorkspaceFile');
    expect(instructions).toContain('Workspace-selection inspection is unavailable in this run.');
    expect(instructions).toContain('Semantic workspace search is unavailable');
    expect(instructions).toContain('Reusable context curation is unavailable');
    expect(instructions).not.toContain('brainstrike_listWorkspaceContext');
    expect(instructions).not.toContain('brainstrike_queryEmbeddingSpace');
  });
});

const FULL_TOOL_MAP = new Map<string, string>([
  ['listWorkspaceContext', 'brainstrike.listWorkspaceContext'],
  ['readWorkspaceContext', 'brainstrike.readWorkspaceContext'],
  ['readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
  ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
  ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
  ['updateWorkspaceContextSelection', 'brainstrike.updateWorkspaceContextSelection'],
  ['updateWorkspaceTapestrySelections', 'brainstrike.updateWorkspaceTapestrySelections'],
  ['findWorkspaceSymbol', 'brainstrike.findWorkspaceSymbol'],
  ['grepSearch', 'brainstrike.grepSearch'],
]);

describe('buildDefaultInstructions', () => {
  it('includes harness/visual framing regardless of tools', () => {
    const prompt = buildDefaultInstructions(new Map());
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toMatch(/Context Explorer/);
    expect(prompt).toMatch(/none/);
  });

  it('makes precise Tapestry selection the default when selection tools are registered', () => {
    const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
    expect(prompt).toMatch(/Context Explorer/);
    expect(prompt).toMatch(/never the whole file/i);
    expect(prompt).toContain('updateWorkspaceTapestrySelections');
    expect(prompt).toContain('updateWorkspaceContextSelection');
    expect(prompt).toMatch(/1-based/);
    expect(prompt).toContain('startLine');
    expect(prompt).toContain('endLine');
  });

  it('forbids whole-file fallback for a named symbol and requires the reported range to match the tool call', () => {
    const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
    // When the user names a specific symbol/function/section, the model must
    // select only that span and must not silently select the whole file.
    expect(prompt).toMatch(/MUST NOT fall back to whole-file/i);
    expect(prompt).toMatch(/symbol, function, type, section, or line range/i);
    // The model previously claimed a precise range in prose while selecting the
    // whole file; the reported range must equal what it passed to the tool.
    expect(prompt).toMatch(/MUST exactly equal the ranges you passed/i);
  });

  it('explains how to derive line ranges from a direct file read (no embedding result)', () => {
    const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
    // Without an embedding index, the model reads the file and counts from the
    // returned startLine to the symbol's first/last line.
    expect(prompt).toMatch(/when there is no embedding result/i);
    expect(prompt).toContain('readWorkspaceFile');
    expect(prompt).toMatch(/first and last line of the requested symbol/i);
    // readWorkspaceFile returns a raw slice with NO inline line numbers, so the
    // prompt must not claim otherwise (that wording produced off-by-one ranges)
    // and must steer the model to count from startLine instead.
    expect(prompt).not.toMatch(/content with 1-based line numbers/i);
    expect(prompt).toMatch(/no inline line numbers/i);
    expect(prompt).toMatch(/count from startLine/i);
  });

  it('degrades gracefully without selection tools and does not leak raw tool IDs into guidance', () => {
    const noSelection = new Map<string, string>([
      ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
      ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
    ]);
    const prompt = buildDefaultInstructions(noSelection);
    expect(prompt).toMatch(/Precise context selection is unavailable/i);
    expect(prompt).not.toContain('brainstrike.updateWorkspaceTapestrySelections');
  });

  it('steers symbol lookup and color grouping when the tools are registered', () => {
    const prompt = buildDefaultInstructions(FULL_TOOL_MAP);
    expect(prompt).toContain('findWorkspaceSymbol');
    // findWorkspaceSymbol is a substring/brace heuristic (best-effort), not exact;
    // the prompt must not call it "exact" (which would tell the model to report a
    // possibly-wrong range as exact) and must steer it to verify the result.
    expect(prompt).toMatch(/best-effort range[^.]*without reading the whole file/i);
    expect(prompt).toMatch(/verify the returned range/i);
    expect(prompt).not.toMatch(/exact range without reading/i);
    expect(prompt).toMatch(/color/i);
    expect(prompt).toMatch(/group related/i);
  });

  it('omits symbol-lookup guidance when findWorkspaceSymbol is not registered', () => {
    const prompt = buildDefaultInstructions(
      new Map([
        ['updateWorkspaceTapestrySelections', 'brainstrike.updateWorkspaceTapestrySelections'],
        ['updateWorkspaceContextSelection', 'brainstrike.updateWorkspaceContextSelection'],
      ])
    );
    expect(prompt).not.toContain('findWorkspaceSymbol');
  });
});

describe('grep-first search orientation', () => {
  const WITH_GREP_MAP = new Map<string, string>([
    ['listWorkspaceContext', 'brainstrike.listWorkspaceContext'],
    ['readWorkspaceContext', 'brainstrike.readWorkspaceContext'],
    ['readWorkspaceFile', 'brainstrike.readWorkspaceFile'],
    ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
    ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
    ['updateWorkspaceContextSelection', 'brainstrike.updateWorkspaceContextSelection'],
    ['updateWorkspaceTapestrySelections', 'brainstrike.updateWorkspaceTapestrySelections'],
    ['findWorkspaceSymbol', 'brainstrike.findWorkspaceSymbol'],
    ['grepSearch', 'brainstrike.grepSearch'],
  ]);

  it('mentions grep tool before semantic-search guidance and contains exact-string usage phrase', () => {
    const instructions = buildDefaultInstructions(WITH_GREP_MAP);

    expect(instructions).toContain('exact strings, identifiers, and error messages');
    // Compare substrings unique to the GUIDANCE sentences (not the tool-name
    // listing line, where both names also appear and would order-match
    // regardless of where the instruction sentences sit).
    expect(instructions.indexOf('FIRST —')).toBeLessThan(
      instructions.indexOf('When you do NOT know the exact wording')
    );
  });

  it('positions semantic search as fallback when grep is registered', () => {
    const instructions = buildDefaultInstructions(WITH_GREP_MAP);
    expect(instructions).toContain('When you do NOT know the exact wording');
  });

  it('states exact-text grep search is unavailable when grepSearch is not registered', () => {
    const noGrep = new Map<string, string>([
      ['listEmbeddingSpaces', 'brainstrike.listEmbeddingSpaces'],
      ['queryEmbeddingSpace', 'brainstrike.queryEmbeddingSpace'],
    ]);
    const instructions = buildDefaultInstructions(noGrep);
    expect(instructions).toContain('Exact-text grep search is unavailable in this run.');
  });
});

describe('multi-root guidance', () => {
  it('teaches the root-qualifier workflow when listWorkspaceContext and a root-qualified tool are registered', () => {
    const instructions = buildDefaultInstructions(FULL_TOOL_MAP);
    expect(instructions).toMatch(/several folders|multiple folders/i);
    expect(instructions).toContain('workspaceRoots');
    expect(instructions).toMatch(/"root" argument/i);
    // Results are labelled with their owning root so the model can disambiguate.
    expect(instructions).toContain('rootName');
    // The root-qualified tools are named in the guidance.
    expect(instructions).toContain('grepSearch');
    expect(instructions).toContain('readWorkspaceFile');
  });

  it('omits multi-root guidance when listWorkspaceContext is not registered', () => {
    const instructions = buildDefaultInstructions(
      new Map<string, string>([['grepSearch', 'brainstrike.grepSearch']])
    );
    expect(instructions).not.toContain('workspaceRoots');
  });

  it('keeps multi-root guidance out of the compact local instruction set', () => {
    const localInstructions = buildLocalDefaultInstructions(FULL_TOOL_MAP);
    expect(localInstructions).not.toContain('workspaceRoots');
  });
});

describe('buildContextBudgetNote', () => {
  it('renders a one-line budget note', () => {
    expect(buildContextBudgetNote(126_000)).toBe(
      'Context budget: about 126.0K tokens of input context are available this run. Suggest starting a new thread if context runs low.'
    );
  });

  it('renders small budgets without K notation', () => {
    expect(buildContextBudgetNote(900)).toBe(
      'Context budget: about 900 tokens of input context are available this run. Suggest starting a new thread if context runs low.'
    );
  });

  it('returns null without a budget', () => {
    expect(buildContextBudgetNote(undefined)).toBeNull();
  });
});
