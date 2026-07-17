import { describe, expect, it } from 'vitest';
import {
  type AssistantPersonaDefinition,
  assertReadOnlyPersona,
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
  PersonaToolRiskViolationError,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '../personas';
import { ASSISTANT_RUN_EVENT_KINDS, type AssistantRunEventKind } from '../run-events';

const baseDefinition = (
  overrides: Partial<AssistantPersonaDefinition>
): AssistantPersonaDefinition => ({
  allowedToolIds: ['brainstrike.grepSearch'],
  description: 'A read-only persona.',
  id: 'explore',
  instructions: 'You are a read-only helper.',
  label: 'Explorer',
  maxSteps: 8,
  ...overrides,
});

describe('assertReadOnlyPersona', () => {
  it('throws PersonaToolRiskViolationError when a persona names an edit-risk tool', () => {
    const persona = baseDefinition({
      allowedToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.writeWorkspaceFile'],
    });
    expect(() => assertReadOnlyPersona(persona)).toThrow(PersonaToolRiskViolationError);
  });

  it('throws when a persona names an execute-risk tool', () => {
    const persona = baseDefinition({ allowedToolIds: ['brainstrike.executeCommand'] });
    expect(() => assertReadOnlyPersona(persona)).toThrow(PersonaToolRiskViolationError);
  });

  it('throws when a persona names a tool absent from the risk registry (unknown is not read)', () => {
    const persona = baseDefinition({ allowedToolIds: ['brainstrike.notARealTool'] });
    expect(() => assertReadOnlyPersona(persona)).toThrow(PersonaToolRiskViolationError);
  });

  it('passes for a persona whose tools all resolve to read risk', () => {
    const persona = baseDefinition({
      allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.webSearch'],
    });
    expect(() => assertReadOnlyPersona(persona)).not.toThrow();
  });

  it('accepts a persona with a model pin as valid contract data (v1 rejection is agent-side)', () => {
    const persona = baseDefinition({ model: { modelId: 'gpt-4o-mini', provider: 'openai' } });
    expect(() => assertReadOnlyPersona(persona)).not.toThrow();
  });
});

describe('BUILT_IN_PERSONAS', () => {
  it('exposes exactly the explore and analyze personas', () => {
    expect(BUILT_IN_PERSONAS.map((persona) => persona.id)).toEqual(['explore', 'analyze']);
  });

  it('every built-in persona is read-only (construction-time enforced)', () => {
    for (const persona of BUILT_IN_PERSONAS) {
      expect(() => assertReadOnlyPersona(persona)).not.toThrow();
    }
  });

  it('explore names exactly its D2 tool list', () => {
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    expect(explore?.allowedToolIds).toEqual([
      'brainstrike.queryEmbeddingSpace',
      'brainstrike.grepSearch',
      'brainstrike.globWorkspace',
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
    ]);
  });

  it('analyze names exactly its D2 tool list (read + web, includes grepSearch)', () => {
    const analyze = BUILT_IN_PERSONAS.find((persona) => persona.id === 'analyze');
    expect(analyze?.allowedToolIds).toEqual([
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
      'brainstrike.grepSearch',
      'brainstrike.webSearch',
      // R5: the extract half of the web-retrieval pair — analysis that finds a
      // result must be able to read the page behind it (still read-risk).
      'brainstrike.webExtract',
    ]);
  });

  it('no built-in persona pins a model in v1', () => {
    for (const persona of BUILT_IN_PERSONAS) {
      expect(persona.model).toBeUndefined();
    }
  });
});

describe('delegation tool naming', () => {
  it('prefixes persona ids with agent-', () => {
    expect(SUBAGENT_DELEGATION_TOOL_PREFIX).toBe('agent-');
    expect(delegationToolNameForPersona('explore')).toBe('agent-explore');
    expect(delegationToolNameForPersona('analyze')).toBe('agent-analyze');
  });
});

describe('subagent run-event kinds', () => {
  it('registers all six subagent kinds in ASSISTANT_RUN_EVENT_KINDS', () => {
    const expected: AssistantRunEventKind[] = [
      'subagent.failed',
      'subagent.finished',
      'subagent.started',
      'subagent.tool.completed',
      'subagent.tool.failed',
      'subagent.tool.started',
    ];
    for (const kind of expected) {
      expect(ASSISTANT_RUN_EVENT_KINDS).toContain(kind);
    }
  });
});
