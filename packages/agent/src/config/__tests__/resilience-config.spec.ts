// packages/agent/src/config/__tests__/resilience-config.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_STALE_MS,
  DEFAULT_STREAM_FIRST_OUTPUT_MS,
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_STREAM_REASONING_GAP_MS,
  DEFAULT_STREAM_STALL_ATTEMPTS,
  DEFAULT_TOOL_CALL_INPUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveApprovalStaleMs,
  resolveAssistantResilienceConfig,
  resolveStreamFirstOutputMs,
  resolveStreamInactivityMs,
  resolveStreamReasoningGapMs,
  resolveStreamStallAttempts,
  resolveToolCallInputMs,
  resolveToolTimeoutMs,
} from '../resilience-config';

describe('resilience-config', () => {
  const KEYS = [
    'BRAINSTRIKE_TOOL_TIMEOUT_MS',
    'BRAINSTRIKE_STREAM_INACTIVITY_MS',
    'BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS',
    'BRAINSTRIKE_STREAM_REASONING_GAP_MS',
    'BRAINSTRIKE_STREAM_STALL_ATTEMPTS',
    'BRAINSTRIKE_TOOL_CALL_INPUT_MS',
    'BRAINSTRIKE_APPROVAL_STALE_MS',
  ] as const;
  afterEach(() => {
    for (const key of KEYS) {
      delete process.env[key];
    }
  });

  it('returns documented defaults when env is absent', () => {
    expect(resolveToolTimeoutMs()).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(resolveStreamInactivityMs()).toBe(DEFAULT_STREAM_INACTIVITY_MS);
  });

  it('uses a valid env override', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '30000';
    expect(resolveToolTimeoutMs()).toBe(30_000);
  });

  it('prefers an explicit override argument over env', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '30000';
    expect(resolveToolTimeoutMs(5000)).toBe(5000);
  });

  it('throws on a malformed env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = 'not-a-number';
    expect(() => resolveToolTimeoutMs()).toThrow(/BRAINSTRIKE_TOOL_TIMEOUT_MS/);
  });

  it('throws on a non-positive env value', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '0';
    expect(() => resolveStreamInactivityMs()).toThrow(/BRAINSTRIKE_STREAM_INACTIVITY_MS/);
  });

  it('resolves the documented assistant resilience defaults together', () => {
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamFirstOutputMs: DEFAULT_STREAM_FIRST_OUTPUT_MS,
      streamInactivityMs: DEFAULT_STREAM_INACTIVITY_MS,
      streamReasoningGapMs: DEFAULT_STREAM_REASONING_GAP_MS,
      streamStallAttempts: DEFAULT_STREAM_STALL_ATTEMPTS,
      toolCallInputMs: DEFAULT_TOOL_CALL_INPUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it('resolves valid tool and stream timeout env values together', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '25';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '50';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '75';
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamFirstOutputMs: DEFAULT_STREAM_FIRST_OUTPUT_MS,
      streamInactivityMs: 50,
      streamReasoningGapMs: DEFAULT_STREAM_REASONING_GAP_MS,
      streamStallAttempts: DEFAULT_STREAM_STALL_ATTEMPTS,
      toolCallInputMs: 75,
      toolTimeoutMs: 25,
    });
  });

  it('gives streamed tool-call input assembly a budget far wider than inactivity', () => {
    // Regression: a legitimate large file write (tens of KB of streamed
    // argument JSON) must not be killed by the inactivity-sized window while
    // deltas are still arriving. See BST-839.
    expect(resolveToolCallInputMs()).toBe(DEFAULT_TOOL_CALL_INPUT_MS);
    expect(DEFAULT_TOOL_CALL_INPUT_MS).toBeGreaterThan(DEFAULT_STREAM_INACTIVITY_MS);
  });

  it('uses a valid tool-call-input env override', () => {
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '900000';
    expect(resolveToolCallInputMs()).toBe(900_000);
  });

  it('throws on a malformed tool-call-input env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = 'soon';
    expect(() => resolveToolCallInputMs()).toThrow(/BRAINSTRIKE_TOOL_CALL_INPUT_MS/);
  });

  it('throws when BOTH budgets are set explicitly and the input one is tighter', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '119999';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_TOOL_CALL_INPUT_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });

  it('widens the DEFAULT input budget to a longer configured inactivity window', () => {
    // A deliberately long inactivity window (slow local route) must not blow up
    // on a variable the user never set. Explicit conflicts still throw; an
    // unset default simply resolves wide enough to satisfy the invariant.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '900000';
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamFirstOutputMs: 900_000,
      streamInactivityMs: 900_000,
      streamReasoningGapMs: 900_000,
      streamStallAttempts: DEFAULT_STREAM_STALL_ATTEMPTS,
      toolCallInputMs: 900_000,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it('keeps the default input budget when it already exceeds inactivity', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    expect(resolveAssistantResilienceConfig().toolCallInputMs).toBe(DEFAULT_TOOL_CALL_INPUT_MS);
  });

  it('returns the documented 24h default for the approval staleness threshold', () => {
    expect(resolveApprovalStaleMs()).toBe(DEFAULT_APPROVAL_STALE_MS);
    expect(DEFAULT_APPROVAL_STALE_MS).toBe(86_400_000);
  });

  it('uses a valid approval-staleness env override', () => {
    process.env['BRAINSTRIKE_APPROVAL_STALE_MS'] = '3600000';
    expect(resolveApprovalStaleMs()).toBe(3_600_000);
  });

  it('throws on a malformed approval-staleness env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_APPROVAL_STALE_MS'] = 'abc';
    expect(() => resolveApprovalStaleMs()).toThrow(/BRAINSTRIKE_APPROVAL_STALE_MS/);
  });

  it('throws on a non-positive approval-staleness env value', () => {
    process.env['BRAINSTRIKE_APPROVAL_STALE_MS'] = '0';
    expect(() => resolveApprovalStaleMs()).toThrow(/BRAINSTRIKE_APPROVAL_STALE_MS/);
  });

  it('gives the first output a window far wider than an inter-output gap', () => {
    // A request carrying a large prompt at high reasoning effort can take
    // minutes to emit ANYTHING, in EVERY step. That is a different question
    // from "how long a gap is tolerable once output is already flowing"
    // (BST-1408), so the two must not share one number.
    expect(resolveStreamFirstOutputMs()).toBe(DEFAULT_STREAM_FIRST_OUTPUT_MS);
    expect(DEFAULT_STREAM_FIRST_OUTPUT_MS).toBeGreaterThan(DEFAULT_STREAM_INACTIVITY_MS);
  });

  it('gives a reasoning gap a window far wider than an inter-output gap', () => {
    // A reasoning delta means the model is THINKING, not answering. The pause
    // between two of them is the same event as the pause before the first one,
    // so it belongs to the wide budget — measuring it against the tight one
    // killed google/gemini-3.7-flash at reasoning.effort 'high'.
    expect(resolveStreamReasoningGapMs()).toBe(DEFAULT_STREAM_REASONING_GAP_MS);
    expect(DEFAULT_STREAM_REASONING_GAP_MS).toBeGreaterThan(DEFAULT_STREAM_INACTIVITY_MS);
  });

  it('uses a valid reasoning-gap env override', () => {
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = '450000';
    expect(resolveStreamReasoningGapMs()).toBe(450_000);
  });

  it('throws on a malformed reasoning-gap env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = 'a while';
    expect(() => resolveStreamReasoningGapMs()).toThrow(/BRAINSTRIKE_STREAM_REASONING_GAP_MS/);
  });

  it('throws on a non-positive reasoning-gap env value', () => {
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = '0';
    expect(() => resolveStreamReasoningGapMs()).toThrow(/BRAINSTRIKE_STREAM_REASONING_GAP_MS/);
  });

  it('throws when an EXPLICIT reasoning gap is tighter than inactivity', () => {
    // Contradictory in the same shape as the first-output rule: a reasoning
    // pause is strictly less suspicious than an answering pause, so a narrower
    // reasoning budget would fire on healthy thought.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = '119999';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_STREAM_REASONING_GAP_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });

  it('widens the DEFAULT reasoning gap to a longer configured inactivity window', () => {
    // Unset must never fail on a variable the user never set — it resolves wide
    // enough to satisfy the invariant instead.
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '900000';
    expect(resolveAssistantResilienceConfig().streamReasoningGapMs).toBe(900_000);
  });

  it('uses a valid first-output env override', () => {
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '450000';
    expect(resolveStreamFirstOutputMs()).toBe(450_000);
  });

  it('prefers an explicit first-output override argument over env', () => {
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '450000';
    expect(resolveStreamFirstOutputMs(7000)).toBe(7000);
  });

  it('throws on a malformed first-output env value (no silent coercion)', () => {
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = 'eventually';
    expect(() => resolveStreamFirstOutputMs()).toThrow(/BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS/);
  });

  it('throws on a non-positive first-output env value', () => {
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '0';
    expect(() => resolveStreamFirstOutputMs()).toThrow(/BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS/);
  });

  it('throws when BOTH windows are set explicitly and the first-output one is tighter', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '119999';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS must be at least BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });

  it('keeps the default first-output window when it already exceeds inactivity', () => {
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    expect(resolveAssistantResilienceConfig().streamFirstOutputMs).toBe(
      DEFAULT_STREAM_FIRST_OUTPUT_MS
    );
  });

  it('resolves every window together when all five are set explicitly', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '25';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '50';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '90';
    process.env['BRAINSTRIKE_STREAM_REASONING_GAP_MS'] = '95';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '75';
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamFirstOutputMs: 90,
      streamInactivityMs: 50,
      streamReasoningGapMs: 95,
      streamStallAttempts: DEFAULT_STREAM_STALL_ATTEMPTS,
      toolCallInputMs: 75,
      toolTimeoutMs: 25,
    });
  });

  it('reports the FOUNDATIONAL ordering first when several invariants break', () => {
    // A config that breaks both orderings must name the tool-timeout rule, not
    // the derived first-output one that only fails as a consequence.
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '200000';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '120000';
    process.env['BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS'] = '100000';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });

  it('defaults to a small stall-attempt budget, and 1 opts out of recovery', () => {
    // A resume re-sends the whole prompt, so the budget is deliberately small;
    // `1` reproduces the pre-BST-1409 immediately-terminal behavior exactly.
    expect(resolveStreamStallAttempts()).toBe(DEFAULT_STREAM_STALL_ATTEMPTS);
    expect(DEFAULT_STREAM_STALL_ATTEMPTS).toBe(2);
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '1';
    expect(resolveStreamStallAttempts()).toBe(1);
  });

  it('throws on a malformed stall-attempt budget, naming the right UNIT', () => {
    // A count reported as "must be a positive integer (ms)" is a strict-parse
    // error that lies about what it wants — on the one knob an operator is most
    // likely to hand-set.
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = 'twice';
    expect(() => resolveStreamStallAttempts()).toThrow(
      /BRAINSTRIKE_STREAM_STALL_ATTEMPTS must be a positive integer \(attempts\)/
    );
    expect(() => resolveStreamStallAttempts()).not.toThrow(/\(ms\)/);
  });

  it('throws on a zero stall-attempt budget (a turn always gets one attempt)', () => {
    process.env['BRAINSTRIKE_STREAM_STALL_ATTEMPTS'] = '0';
    expect(() => resolveStreamStallAttempts()).toThrow(/BRAINSTRIKE_STREAM_STALL_ATTEMPTS/);
  });

  it('throws when the tool timeout is not shorter than stream inactivity', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '100';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '100';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });
});
