import { describe, expect, it } from 'vitest';
import { deriveChildFirstSteps, deriveThreadDebugLegs } from '../diagnostics/thread-debug-legs';

// Rows carry the snapshot's SQL column names (row_to_json), as the pack receives them.
describe('deriveThreadDebugLegs', () => {
  it('joins each run with its terminal metadata, step counts, upstreams and child persona', () => {
    const legs = deriveThreadDebugLegs({
      conversations: [
        { configuration: {}, delegation_depth: 0, thread_id: 'root' },
        {
          configuration: {
            maxSteps: 16,
            persona: { allowedToolIds: ['brainstrike.grepSearch'], id: 'explore' },
          },
          delegation_depth: 1,
          thread_id: 'child',
        },
      ],
      events: [
        {
          kind: 'run.step.finished',
          metadata: { finishReason: 'tool-calls', openRouterProvider: 'Mistral' },
          run_id: 'root-run',
          thread_id: 'root',
        },
        {
          kind: 'run.step.finished',
          metadata: { finishReason: 'length', openRouterProvider: 'DeepInfra' },
          run_id: 'root-run',
          thread_id: 'root',
        },
        {
          kind: 'run.finished',
          metadata: {
            completionTokens: 5921,
            finishReason: 'stop',
            openRouterProvider: 'Mistral',
            promptTokens: 95_863,
          },
          run_id: 'root-run',
          thread_id: 'root',
        },
        {
          kind: 'run.failed',
          metadata: { finishReason: 'length' },
          run_id: 'child-run',
          thread_id: 'child',
        },
      ],
      runs: [
        {
          completed_at: '2026-09-15T03:29:29Z',
          id: 'root-run',
          model: 'z-ai/glm-5.2',
          provider: 'openrouter',
          started_at: '2026-09-15T03:27:29Z',
          status: 'completed',
          thread_id: 'root',
        },
        {
          completed_at: null,
          id: 'child-run',
          model: 'z-ai/glm-5.2',
          provider: 'openrouter',
          started_at: '2026-09-15T03:27:41Z',
          status: 'failed',
          thread_id: 'child',
        },
      ],
    });

    expect(legs).toEqual([
      {
        completedAt: '2026-09-15T03:29:29Z',
        completionTokens: 5921,
        finishReason: 'stop',
        kind: 'root',
        lastStepFinishReason: 'length',
        lengthCutSteps: 1,
        model: 'z-ai/glm-5.2',
        openRouterProviders: ['DeepInfra', 'Mistral'],
        personaId: null,
        promptTokens: 95_863,
        provider: 'openrouter',
        runId: 'root-run',
        startedAt: '2026-09-15T03:27:29Z',
        status: 'completed',
        steps: 2,
        threadId: 'root',
      },
      {
        completedAt: null,
        completionTokens: null,
        finishReason: 'length',
        kind: 'delegated',
        lastStepFinishReason: null,
        lengthCutSteps: 0,
        model: 'z-ai/glm-5.2',
        openRouterProviders: [],
        personaId: 'explore',
        promptTokens: null,
        provider: 'openrouter',
        runId: 'child-run',
        startedAt: '2026-09-15T03:27:41Z',
        status: 'failed',
        steps: 0,
        threadId: 'child',
      },
    ]);
  });

  it('names why a leg that ended paused stopped, without inventing a terminal finish', () => {
    // Live run 21 (2026-09-15): the GLM root paused on a canvas approval. Its
    // host run row reads completed, every step finished on tool-calls, and no
    // run.finished/failed/cancelled event exists because the leg ended as a
    // pause. The terminal reason stays null; the last step's reason is named.
    const [leg] = deriveThreadDebugLegs({
      events: [
        {
          kind: 'run.step.finished',
          metadata: { finishReason: 'tool-calls', openRouterProvider: 'Novita' },
          run_id: 'paused-run',
          thread_id: 'root',
        },
        {
          kind: 'tool.approval.requested',
          metadata: { toolName: 'brainstrike.manageCanvas' },
          run_id: 'paused-run',
          thread_id: 'root',
        },
        {
          kind: 'run.step.finished',
          metadata: { finishReason: 'tool-calls', openRouterProvider: 'Novita' },
          run_id: 'paused-run',
          thread_id: 'root',
        },
      ],
      runs: [
        {
          completed_at: '2026-09-15T17:19:19Z',
          id: 'paused-run',
          model: 'z-ai/glm-5.2',
          provider: 'openrouter',
          started_at: '2026-09-15T17:14:42Z',
          status: 'completed',
          thread_id: 'root',
        },
      ],
    });
    expect(leg).toMatchObject({
      finishReason: null,
      lastStepFinishReason: 'tool-calls',
      openRouterProviders: ['Novita'],
      steps: 2,
    });
  });

  it('refuses a run row without its identity instead of dropping the leg', () => {
    expect(() =>
      deriveThreadDebugLegs({ runs: [{ status: 'completed', thread_id: 'root' }] })
    ).toThrow('runs row is missing id');
  });
});

describe('deriveChildFirstSteps', () => {
  it('takes the EARLIEST child-first-step row per dispatch address and lists later re-entries', () => {
    const steps = deriveChildFirstSteps({
      invocations: [
        {
          parent_runtime_run_id: 'native-root',
          parent_tool_call_id: 'delegate-call',
          persona_id: 'explore',
          thread_id: 'child',
        },
      ],
      promptManifests: [
        {
          created_at: '2026-09-15T00:00:01Z',
          id: 'pm-root',
          kind: 'root-leg',
          native_run_id: null,
          parent_tool_call_id: null,
          persona_id: null,
          thread_id: 'root',
        },
        // Out of timestamp order on purpose: "earliest" is by created_at, not array position.
        {
          created_at: '2026-09-15T00:00:04Z',
          id: 'pm-child-reentry',
          kind: 'child-first-step',
          native_run_id: 'native-root',
          parent_tool_call_id: 'delegate-call',
          persona_id: 'explore',
          thread_id: 'root',
        },
        {
          created_at: '2026-09-15T00:00:02Z',
          id: 'pm-child',
          kind: 'child-first-step',
          native_run_id: 'native-root',
          parent_tool_call_id: 'delegate-call',
          persona_id: 'explore',
          thread_id: 'root',
        },
        {
          created_at: '2026-09-15T00:00:03Z',
          id: 'pm-leaf',
          kind: 'child-first-step',
          native_run_id: 'native-child',
          parent_tool_call_id: 'nested-call',
          persona_id: 'explore',
          thread_id: 'child',
        },
      ],
    });

    expect(steps).toEqual([
      {
        childThreadId: 'child',
        createdAt: '2026-09-15T00:00:02Z',
        dispatchingThreadId: 'root',
        manifestId: 'pm-child',
        nativeRunId: 'native-root',
        parentToolCallId: 'delegate-call',
        personaId: 'explore',
        reentryManifestIds: ['pm-child-reentry'],
      },
      {
        childThreadId: null,
        createdAt: '2026-09-15T00:00:03Z',
        dispatchingThreadId: 'child',
        manifestId: 'pm-leaf',
        nativeRunId: 'native-child',
        parentToolCallId: 'nested-call',
        personaId: 'explore',
        reentryManifestIds: [],
      },
    ]);
  });

  it('refuses a child-first-step row without its dispatch address', () => {
    expect(() =>
      deriveChildFirstSteps({
        promptManifests: [
          {
            created_at: '2026-09-15T00:00:02Z',
            id: 'pm',
            kind: 'child-first-step',
            native_run_id: null,
            parent_tool_call_id: 'delegate-call',
            thread_id: 'root',
          },
        ],
      })
    ).toThrow('promptManifests row is missing native_run_id');
  });
});
