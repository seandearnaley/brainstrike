import { describe, expect, it } from 'vitest';
import * as toolSchemas from '../tools/schemas';

const EXPECTED_DESKTOP_NATIVE_TOOL_IDS = [
  'brainstrike.askUser',
  'brainstrike.deleteWorkspaceFile',
  'brainstrike.executeCommand',
  'brainstrike.findWorkspaceSymbol',
  'brainstrike.globWorkspace',
  'brainstrike.grepSearch',
  'brainstrike.hybridSearch',
  'brainstrike.listEmbeddingSpaces',
  'brainstrike.listWorkspaceContext',
  'brainstrike.lspInspect',
  'brainstrike.manageTaskList',
  'brainstrike.queryEmbeddingSpace',
  'brainstrike.readToolOutputArtifact',
  'brainstrike.readWorkspaceContext',
  'brainstrike.readWorkspaceDirectory',
  'brainstrike.readWorkspaceFile',
  'brainstrike.renameWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.submitPlan',
  'brainstrike.updateWorkspaceContextSelection',
  'brainstrike.updateWorkspaceTapestrySelections',
  'brainstrike.webExtract',
  'brainstrike.webSearch',
  'brainstrike.writeWorkspaceFile',
] as const;

describe('native tool input schema catalog', () => {
  it('exports exact desktop-native parity without stale web or Mastra-owned skill entries', () => {
    const registry = Reflect.get(toolSchemas, 'NATIVE_TOOL_INPUT_SCHEMAS');
    expect(
      registry,
      'NATIVE_TOOL_INPUT_SCHEMAS must be the exported agent-only Zod schema source'
    ).toEqual(expect.any(Object));
    if (!(registry && typeof registry === 'object')) {
      throw new TypeError('NATIVE_TOOL_INPUT_SCHEMAS must be an object');
    }

    expect(Object.keys(registry).sort()).toEqual([...EXPECTED_DESKTOP_NATIVE_TOOL_IDS].sort());
    expect(registry).not.toHaveProperty('web.echo');
    expect(registry).not.toHaveProperty('skill');
    expect(registry).not.toHaveProperty('skill_read');
    expect(registry).not.toHaveProperty('skill_search');
  });
});
