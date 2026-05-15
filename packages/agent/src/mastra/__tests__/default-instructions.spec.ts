import { describe, expect, it } from 'vitest';
import { buildDefaultInstructions } from '../default-instructions';

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
    expect(instructions).toContain('recommendedForWorkspaceSearch');
    expect(instructions).toContain('semantic chunks with persisted source line ranges');
    expect(instructions).toContain('Only run state-changing tools after the user confirms.');
    expect(instructions).not.toContain('brainstrike.listWorkspaceContext');
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
