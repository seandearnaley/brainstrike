// packages/agent/src/config/__tests__/resilience-config.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_STALE_MS,
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_TOOL_CALL_INPUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveApprovalStaleMs,
  resolveAssistantResilienceConfig,
  resolveStreamInactivityMs,
  resolveToolCallInputMs,
  resolveToolTimeoutMs,
} from '../resilience-config';

describe('resilience-config', () => {
  const KEYS = [
    'BRAINSTRIKE_TOOL_TIMEOUT_MS',
    'BRAINSTRIKE_STREAM_INACTIVITY_MS',
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
      streamInactivityMs: DEFAULT_STREAM_INACTIVITY_MS,
      toolCallInputMs: DEFAULT_TOOL_CALL_INPUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it('resolves valid tool and stream timeout env values together', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '25';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '50';
    process.env['BRAINSTRIKE_TOOL_CALL_INPUT_MS'] = '75';
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamInactivityMs: 50,
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
      streamInactivityMs: 900_000,
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

  it('throws when the tool timeout is not shorter than stream inactivity', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '100';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '100';
    expect(() => resolveAssistantResilienceConfig()).toThrow(
      /BRAINSTRIKE_TOOL_TIMEOUT_MS must be less than BRAINSTRIKE_STREAM_INACTIVITY_MS/
    );
  });
});
