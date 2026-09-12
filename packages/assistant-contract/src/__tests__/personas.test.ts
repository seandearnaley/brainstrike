import { describe, expect, it } from 'vitest';
import { DELEGATION_LIMITS } from '../delegation-limits';
import {
  type AssistantPersonaDefinition,
  assertReadOnlyPersona,
  BUILT_IN_PERSONAS,
  delegationDescriptionForPersona,
  delegationToolNameForPersona,
  effectiveChildStepBudget,
  PersonaToolRiskViolationError,
  personaScope,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '../personas';
import { ASSISTANT_RUN_EVENT_KINDS, type AssistantRunEventKind } from '../run-events';
import { MAX_USER_PERSONA_MAX_STEPS } from '../user-personas';

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

describe('effectiveChildStepBudget', () => {
  it('is the declared budget capped by the tree-wide ceiling, and is what the model is told', () => {
    const within = { description: 'd', maxSteps: 4 };
    const over = { description: 'd', maxSteps: DELEGATION_LIMITS.maxChildSteps + 20 };
    expect(effectiveChildStepBudget(within)).toBe(4);
    expect(effectiveChildStepBudget(over)).toBe(DELEGATION_LIMITS.maxChildSteps);
    expect(delegationDescriptionForPersona(within)).toContain('Runs at most 4 steps');
    expect(delegationDescriptionForPersona(over)).toContain(
      `Runs at most ${DELEGATION_LIMITS.maxChildSteps} steps`
    );
  });
});

describe('personaScope', () => {
  it('reports read-only for legacy personas without a mode and worker for explicit workers', () => {
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    const worker = BUILT_IN_PERSONAS.find((persona) => persona.id === 'worker');
    if (!(explore && worker)) {
      throw new Error('built-ins missing');
    }
    expect(personaScope(explore)).toEqual({
      allowedToolIds: explore.allowedToolIds,
      maxSteps: explore.maxSteps,
      mode: 'read-only',
    });
    expect(personaScope(worker)).toEqual({
      allowedToolIds: ['*'],
      maxSteps: worker.maxSteps,
      mode: 'worker',
    });
  });
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
  it('exposes read-only specialists and an explicit worker', () => {
    expect(BUILT_IN_PERSONAS.map((persona) => persona.id)).toEqual([
      'explore',
      'analyze',
      'worker',
    ]);
  });

  it('existing specialists remain read-only (construction-time enforced)', () => {
    for (const persona of BUILT_IN_PERSONAS.filter((entry) => entry.id !== 'worker')) {
      expect(() => assertReadOnlyPersona(persona)).not.toThrow();
    }
  });

  it('explore names exactly its D2 tool list', () => {
    const explore = BUILT_IN_PERSONAS.find((persona) => persona.id === 'explore');
    expect(explore?.allowedToolIds).toEqual([
      'brainstrike.queryEmbeddingSpace',
      'brainstrike.grepSearch',
      'brainstrike.globWorkspace',
      'brainstrike.readToolOutputArtifact',
      'brainstrike.readWorkspaceFile',
      'brainstrike.readWorkspaceDirectory',
    ]);
  });

  it('analyze names exactly its D2 tool list (read + web, includes grepSearch)', () => {
    const analyze = BUILT_IN_PERSONAS.find((persona) => persona.id === 'analyze');
    expect(analyze?.allowedToolIds).toEqual([
      'brainstrike.readToolOutputArtifact',
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

describe('delegationDescriptionForPersona', () => {
  const persona = (maxSteps: number) => ({
    allowedToolIds: [],
    description: 'Delegate exploration.',
    id: 'x',
    instructions: 'i',
    label: 'X',
    maxSteps,
  });

  it('derives the cap from maxSteps instead of restating it in prose', () => {
    // The supervisor picks the SIZE of a delegated task from this description
    // and nothing else — it becomes the `agent-<id>` tool description. Deriving
    // it here rather than writing "16 steps" into each persona's prose removes
    // the drift entirely: there is no second copy to fall out of sync.
    expect(delegationDescriptionForPersona(persona(16))).toContain('at most 16 steps');
    expect(delegationDescriptionForPersona(persona(4))).toContain('at most 4 steps');
  });

  it('covers USER-defined personas, whose frontmatter never mentions a cap', () => {
    // A user persona's description comes straight from its markdown frontmatter,
    // so it can never disclose its own budget. Hardcoding the sentence in the
    // built-ins would have left exactly this case with the original bug.
    const userPersona: AssistantPersonaDefinition = { ...persona(4), source: 'user' };
    expect(delegationDescriptionForPersona(userPersona)).toContain('at most 4 steps');
  });

  it('keeps the persona own description intact', () => {
    expect(delegationDescriptionForPersona(persona(16))).toContain('Delegate exploration.');
  });

  it('discloses a cap for every built-in', () => {
    for (const builtIn of BUILT_IN_PERSONAS) {
      expect(delegationDescriptionForPersona(builtIn)).toContain(
        `at most ${builtIn.maxSteps} steps`
      );
    }
  });

  it('gives every built-in the budget a user persona is also allowed', () => {
    // One step is reserved in-loop for the wrap-up summary
    // (buildChildIterationPolicy), so the usable tool budget is maxSteps - 1.
    // At the previous cap of 8 that left 7 tool steps for a persona whose own
    // description invites surveying many files.
    //
    // The built-ins sit AT the user ceiling, never above it: a budget users
    // cannot declare would make the shipped Explorer unreplicable by a user
    // persona, and would leave MAX_USER_PERSONA_MAX_STEPS describing a limit
    // the app itself ignores.
    for (const builtIn of BUILT_IN_PERSONAS) {
      expect(builtIn.maxSteps).toBe(MAX_USER_PERSONA_MAX_STEPS);
    }
  });
});

describe('persona instructions demand provenance, not conclusions', () => {
  it('requires every finding to distinguish code from documentation', () => {
    // An explore child reported FOREGROUND_GATE_REOPEN_MS=250 as a code
    // constant. It exists only in docs/agents/local-inference.md — the doc
    // itself says the real constant is named something else. The supervisor
    // then wrote it into durable memory under "Verified architecture survey".
    for (const persona of BUILT_IN_PERSONAS) {
      expect(persona.instructions.toLowerCase()).toContain('documentation');
    }
  });

  it('keeps read-only specialists focused on findings', () => {
    // An explore child asked to survey the repo "for a developer-onboarding
    // document" returned a complete HTML page. It is a research step, not the
    // author: the supervisor discarded the page and the child had burned its
    // budget writing it.
    //
    // The Analyst is delegated research for reports and pages too, so guarding
    // only `explore` would leave the identical budget-waster one delegation
    // away.
    for (const persona of BUILT_IN_PERSONAS.filter((entry) => entry.mode !== 'worker')) {
      expect(persona.instructions.toLowerCase()).toContain('do not produce the final deliverable');
    }
  });
});
