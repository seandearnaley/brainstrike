// packages/agent/src/config/__tests__/resilience-config.spec.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_STALE_MS,
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveApprovalStaleMs,
  resolveAssistantResilienceConfig,
  resolveStreamInactivityMs,
  resolveToolTimeoutMs,
} from '../resilience-config';

describe('resilience-config', () => {
  const KEYS = [
    'BRAINSTRIKE_TOOL_TIMEOUT_MS',
    'BRAINSTRIKE_STREAM_INACTIVITY_MS',
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
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    });
  });

  it('resolves valid tool and stream timeout env values together', () => {
    process.env['BRAINSTRIKE_TOOL_TIMEOUT_MS'] = '25';
    process.env['BRAINSTRIKE_STREAM_INACTIVITY_MS'] = '50';
    expect(resolveAssistantResilienceConfig()).toEqual({
      streamInactivityMs: 50,
      toolTimeoutMs: 25,
    });
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
