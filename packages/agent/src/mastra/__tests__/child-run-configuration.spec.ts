import {
  intersectChildPermissionCeilings,
  normalizeAssistantChildInput,
  type PermissionToolGateSnapshot,
  resolvePermissionDecision,
  serializeAssistantChildInput,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { configureChildContinuation, restoreChildExecution } from '../child-run-configuration';

const persona = {
  allowedToolIds: ['brainstrike.grepSearch', 'brainstrike.readWorkspaceFile'],
  description: 'Read',
  id: 'reader',
  instructions: 'Read evidence',
  label: 'Reader',
  maxSteps: 4,
};
const configuration = { maxSteps: 3, persona };
const permissionPolicy: PermissionToolGateSnapshot = {
  policies: { edit: 'ask', execute: 'deny', mcp: 'ask', read: 'allow' },
  yolo: false,
};
const options = { permissionPolicy, runtime: { model: 'gpt-5.6-sol', provider: 'openai' } };
const input = { id: 'input', text: 'Continue' };

describe('host admitted child execution configuration', () => {
  it('uses the current authenticated root model for an unpinned child and captures the ceiling', () => {
    expect(configureChildContinuation(configuration, input, options)).toMatchObject({
      execution: { model: 'gpt-5.6-sol', permissionPolicy, provider: 'openai' },
      maxSteps: 3,
      persona: { model: { modelId: 'gpt-5.6-sol', provider: 'openai' } },
    });
    expect(configuration.persona).not.toHaveProperty('model');
  });
  it('only reduces the admitted catalog and rejects current-root plan widening', () => {
    expect(
      configureChildContinuation(
        configuration,
        { ...input, nextRun: { disabledToolIds: ['brainstrike.grepSearch'] } },
        options
      )
    ).toMatchObject({ persona: { allowedToolIds: ['brainstrike.readWorkspaceFile'] } });
    expect(() =>
      configureChildContinuation(
        configuration,
        { ...input, nextRun: { disabledToolIds: ['unadmitted'] } },
        options
      )
    ).toThrow('admitted tool catalog');
    expect(() =>
      configureChildContinuation(
        configuration,
        { ...input, nextRun: { planMode: false } },
        { ...options, runtime: { ...options.runtime, planMode: true } }
      )
    ).toThrow('root plan mode');
  });
  it('restores exact admitted effort through later root settings and preserves the stricter permission boundary', () => {
    const admitted = configureChildContinuation(
      configuration,
      {
        ...input,
        nextRun: {
          modelSettings: { maxOutputTokens: 777 },
          providerOptions: { openai: { reasoningEffort: 'high' } },
        },
      },
      options
    );
    const restored = restoreChildExecution(admitted, {
      permissionPolicy: { ...permissionPolicy, yolo: true },
      runtime: {
        ...options.runtime,
        modelSettings: { maxOutputTokens: 42 },
        providerOptions: { openai: { reasoningEffort: 'low' } },
      },
    });
    expect(restored.runtime).toMatchObject({
      modelSettings: { maxOutputTokens: 777 },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(restored.permissionPolicy?.policies).toEqual(permissionPolicy.policies);
    expect(restored.permissionPolicy?.yolo).toBe(false);
  });
  it('binds changed settings to the whole receipt and refuses credential or permission injection', () => {
    expect(serializeAssistantChildInput(input)).not.toBe(
      serializeAssistantChildInput({ ...input, nextRun: { planMode: true } })
    );
    expect(() =>
      normalizeAssistantChildInput({
        ...input,
        nextRun: { providerOptions: { openai: { apiKey: 'secret' } } },
      })
    ).toThrow();
  });
});

it('does not widen an unclassified tool when the root changes its default risk category', () => {
  const result = intersectChildPermissionCeilings(
    { ...permissionPolicy, defaultRisk: 'execute' },
    { ...permissionPolicy, defaultRisk: 'read' }
  );
  if (!result) {
    throw new Error('Missing permission ceiling');
  }
  expect(
    resolvePermissionDecision({
      ...result,
      riskCategory: result.defaultRisk ?? 'mcp',
      sessionGrants: new Set(result.sessionGrants),
      toolId: 'unknown.tool',
    })
  ).toBe('deny');
});
