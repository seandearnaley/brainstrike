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
  it('restores exact admitted effort through later root settings and lets a later root grant lift admitted asks', () => {
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
    // Root yolo after admission is a root user grant: every admitted ask/allow
    // follows it, while the admitted `execute: deny` stays frozen.
    expect(restored.permissionPolicy?.policies).toEqual({
      edit: 'allow',
      execute: 'deny',
      mcp: 'allow',
      read: 'allow',
    });
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

describe('child permission ceiling honors root grants made after admission', () => {
  const riskByTool = {
    'brainstrike.executeCommand': 'execute',
    'brainstrike.readWorkspaceDirectory': 'read',
    'brainstrike.readWorkspaceFile': 'read',
  } as const;
  type ToolId = keyof typeof riskByTool;
  // The exact posture from the 2026-09-12 readWorkspaceDirectory approval loop:
  // `read: 'ask'` with a per-tool allow for the file reader and none for the
  // directory reader, captured with no session grants.
  const admitted: PermissionToolGateSnapshot = {
    defaultRisk: 'mcp',
    perToolOverrides: { 'brainstrike.readWorkspaceFile': 'allow' },
    policies: { edit: 'ask', execute: 'deny', mcp: 'allow', read: 'ask' },
    riskByTool: { ...riskByTool },
    sessionGrants: [],
    yolo: false,
  };
  const decide = (snapshot: PermissionToolGateSnapshot | undefined, toolId: ToolId) => {
    if (!snapshot) {
      throw new Error('Missing permission ceiling');
    }
    return resolvePermissionDecision({
      ...snapshot,
      riskCategory: riskByTool[toolId],
      sessionGrants: new Set(snapshot.sessionGrants),
      toolId,
    });
  };

  it('a session grant made after admission lifts an admitted ask to allow', () => {
    const result = intersectChildPermissionCeilings(admitted, {
      ...admitted,
      sessionGrants: ['read'],
    });
    expect(decide(result, 'brainstrike.readWorkspaceDirectory')).toBe('allow');
  });

  it('an "Always allow" per-tool override made after admission lifts an admitted ask', () => {
    const result = intersectChildPermissionCeilings(admitted, {
      ...admitted,
      perToolOverrides: {
        ...admitted.perToolOverrides,
        'brainstrike.readWorkspaceDirectory': 'allow',
      },
    });
    expect(decide(result, 'brainstrike.readWorkspaceDirectory')).toBe('allow');
  });

  it('an admitted deny survives every later root widening, including yolo', () => {
    const widened = intersectChildPermissionCeilings(admitted, {
      ...admitted,
      perToolOverrides: { 'brainstrike.executeCommand': 'allow' },
      policies: { ...admitted.policies, execute: 'allow' },
      sessionGrants: ['read', 'edit', 'execute', 'mcp'],
      yolo: true,
    });
    expect(decide(widened, 'brainstrike.executeCommand')).toBe('deny');
    expect(decide(widened, 'brainstrike.readWorkspaceDirectory')).toBe('allow');
    expect(widened?.yolo).toBe(false);
  });

  it('a later root reduction still applies to an admitted allow', () => {
    const reduced = intersectChildPermissionCeilings(admitted, {
      ...admitted,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'ask' },
    });
    expect(decide(reduced, 'brainstrike.readWorkspaceFile')).toBe('ask');
    const denied = intersectChildPermissionCeilings(admitted, {
      ...admitted,
      perToolOverrides: { 'brainstrike.readWorkspaceFile': 'deny' },
    });
    expect(decide(denied, 'brainstrike.readWorkspaceFile')).toBe('deny');
  });

  it('keeps the admitted posture when the root sends no policy', () => {
    const result = intersectChildPermissionCeilings(admitted, undefined);
    expect(decide(result, 'brainstrike.readWorkspaceDirectory')).toBe('ask');
    expect(decide(result, 'brainstrike.readWorkspaceFile')).toBe('allow');
  });
});
