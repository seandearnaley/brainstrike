import { describe, expect, it } from 'vitest';
import * as assistantContract from '../index';
import { NATIVE_TOOL_DEFAULTS } from '../tool-categories';
import { TOOL_DESCRIPTIONS } from '../tool-descriptions';
import { NATIVE_TOOL_SCHEMAS } from '../tool-schemas-display';

const EXPECTED_DESKTOP_NATIVE_TOOL_IDS = [
  'brainstrike.askUser',
  'brainstrike.deleteWorkspaceFile',
  'brainstrike.executeCommand',
  'brainstrike.findWorkspaceSymbol',
  'brainstrike.globWorkspace',
  'brainstrike.grepSearch',
  'brainstrike.hybridSearch',
  'brainstrike.inspectCommandSessions',
  'brainstrike.listEmbeddingSpaces',
  'brainstrike.listWorkspaceContext',
  'brainstrike.lspInspect',
  'brainstrike.manageTaskList',
  'brainstrike.manageCommandSession',
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

const EXPECTED_SKILL_NATIVE_TOOL_IDS = ['skill', 'skill_read', 'skill_search'] as const;

function readCanonicalIds(exportName: string): readonly string[] {
  const value = Reflect.get(assistantContract, exportName);
  expect(
    value,
    `${exportName} must be exported by @brainstrike/assistant-contract as the canonical tool-id source`
  ).toEqual(expect.any(Array));
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    throw new TypeError(`${exportName} must contain only tool-id strings`);
  }
  return value;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('native tool catalog', () => {
  it('publishes one unique canonical id list with explicit desktop and skill partitions', () => {
    const desktopIds = readCanonicalIds('DESKTOP_NATIVE_TOOL_IDS');
    const skillIds = readCanonicalIds('SKILL_NATIVE_TOOL_IDS');
    const nativeIds = readCanonicalIds('NATIVE_TOOL_IDS');

    expect(sorted(desktopIds)).toEqual(sorted(EXPECTED_DESKTOP_NATIVE_TOOL_IDS));
    expect(sorted(skillIds)).toEqual(sorted(EXPECTED_SKILL_NATIVE_TOOL_IDS));
    expect(sorted(nativeIds)).toEqual(
      sorted([...EXPECTED_DESKTOP_NATIVE_TOOL_IDS, ...EXPECTED_SKILL_NATIVE_TOOL_IDS])
    );
    expect(new Set(nativeIds).size).toBe(nativeIds.length);
    expect(desktopIds).toHaveLength(26);
    expect(skillIds).toHaveLength(3);
  });

  it('keeps every browser-safe registry in exact parity with the canonical ids', () => {
    const canonicalIds = sorted(readCanonicalIds('NATIVE_TOOL_IDS'));

    expect(sorted(Object.keys(NATIVE_TOOL_DEFAULTS))).toEqual(canonicalIds);
    expect(sorted(Object.keys(TOOL_DESCRIPTIONS))).toEqual(canonicalIds);
    expect(sorted(Object.keys(NATIVE_TOOL_SCHEMAS))).toEqual(canonicalIds);
  });

  it('keeps each display schema self-identifying as its canonical map key', () => {
    for (const [toolId, schema] of Object.entries(NATIVE_TOOL_SCHEMAS)) {
      expect(schema.toolId, `${toolId} carries a mismatched display-schema toolId`).toBe(toolId);
    }
  });
});
