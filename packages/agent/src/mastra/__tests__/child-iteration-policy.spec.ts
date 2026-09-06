/**
 * BST-1410 follow-up: the child's LAST step is reserved for its summary using
 * Mastra's own `onIterationComplete` hook (docs/subagents.md), NOT a bolt-on
 * second `agent.stream()` call.
 *
 * These cases pin the POLICY in isolation. Its behaviour end-to-end through the
 * real supervisor/child loop — including that the feedback reaches the child's
 * next model call and that the reserve is spent from the declared budget rather
 * than added on top of it — is pinned by the wrap-up case in
 * `mastra-subagent-execution.integration.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { buildChildIterationPolicy, CHILD_WRAP_UP_FEEDBACK } from '../build-persona-subagents';

type PolicyContext = Parameters<ReturnType<typeof buildChildIterationPolicy>>[0];

function iteration(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    agentId: 'explore',
    agentName: 'Explorer',
    finishReason: 'tool-calls',
    isFinal: false,
    iteration: 1,
    maxIterations: 8,
    messages: [],
    runId: 'run-1',
    text: '',
    toolCalls: [],
    toolResults: [],
    ...overrides,
  } as PolicyContext;
}

describe('buildChildIterationPolicy', () => {
  it('reserves the step BEFORE the cap, so the summary turn still fits inside it', () => {
    const policy = buildChildIterationPolicy();
    expect(policy(iteration({ iteration: 7, maxIterations: 8 }))).toEqual({
      continue: false,
      feedback: CHILD_WRAP_UP_FEEDBACK,
    });
  });

  it('stays silent while the child still has steps to spend on tools', () => {
    const policy = buildChildIterationPolicy();
    for (const current of [1, 2, 5, 6]) {
      expect(policy(iteration({ iteration: current, maxIterations: 8 }))).toBeUndefined();
    }
  });

  it('fires even when the tool-calling step carried a narration preamble', () => {
    // Review of #2596. Claude and GPT routinely emit a sentence alongside a tool
    // call ("Let me check the packages directory..."), so `text` is non-empty on
    // an ordinary tool-looping step. Treating that as "already answering" would
    // suppress the reserve, let the child spend its last step on another tool,
    // and then hand the parent the PREAMBLE as the analysis — non-empty, so the
    // no-answer path never fires either. That is BST-1410 again, wearing a
    // plausible disguise, on exactly the models this feature targets.
    //
    // Core already gates injection on `stepResult.isContinued`, so a child that
    // genuinely finished is never reached here. Text is not a completion signal.
    const policy = buildChildIterationPolicy();
    expect(
      policy(
        iteration({
          iteration: 7,
          maxIterations: 8,
          text: 'Let me check the packages directory.',
          toolCalls: [{ args: {}, id: 'c1', name: 'brainstrike_grepSearch' }],
        })
      )
    ).toEqual({ continue: false, feedback: CHILD_WRAP_UP_FEEDBACK });
  });

  it('never fires when there is no earlier step to spend on tools', () => {
    // A one-step child has a single turn; reserving it would consume the only
    // step the persona was given, so the policy must leave it alone.
    const policy = buildChildIterationPolicy();
    expect(policy(iteration({ iteration: 1, maxIterations: 1 }))).toBeUndefined();
  });

  it('never fires when the cap is unknown', () => {
    // `maxIterations` is optional on the hook context. Guessing a cap would
    // cut a child short on a budget nobody declared.
    const policy = buildChildIterationPolicy();
    expect(policy(iteration({ iteration: 40, maxIterations: undefined }))).toBeUndefined();
  });

  it('still fires past the reserve point, so an off-by-one cannot skip it', () => {
    const policy = buildChildIterationPolicy();
    expect(policy(iteration({ iteration: 8, maxIterations: 8 }))).toMatchObject({
      continue: false,
    });
  });

  it('tells the child it is the FINAL turn and that no tools will run', () => {
    // The instruction has to be unambiguous: a child that thinks it can call
    // one more tool spends its reserved turn on a tool call and answers nothing
    // — the exact failure this reserve exists to prevent.
    expect(CHILD_WRAP_UP_FEEDBACK).toMatch(/final turn/i);
    expect(CHILD_WRAP_UP_FEEDBACK).toMatch(/no further tool calls/i);
    expect(CHILD_WRAP_UP_FEEDBACK).toMatch(/only what you already found/i);
  });
});
