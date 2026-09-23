import { describe, expect, it } from 'vitest';
import * as contract from '../index.js';
import {
  applyTurnSubagentLimits,
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  NODE_TIMER_MAX_MS,
  parseRuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
  resolveChildTaskTimeoutMs,
  SUBAGENT_SETTINGS_LIMITS,
} from '../subagent-settings.js';

describe('RuntimeSubagentSettings', () => {
  it('ships the raised defaults the swarm runs need', () => {
    expect(DEFAULT_RUNTIME_SUBAGENT_SETTINGS).toEqual({
      maxChildOutputTokens: 32_768,
      maxChildRuntimeMs: null,
      maxChildSteps: 100,
      maxConcurrentWork: 6,
      maxDepth: 3,
      maxInvocations: 200,
      maxStepOutputTokens: 8192,
      maxTreeOutputTokens: 6_553_600,
      synthesisOutputTokens: 2048,
    });
  });

  it('defaults the tree output budget so it never binds before the per-child and invocation caps', () => {
    const defaults = DEFAULT_RUNTIME_SUBAGENT_SETTINGS;
    expect(defaults.maxTreeOutputTokens).toBe(
      defaults.maxInvocations * defaults.maxChildOutputTokens
    );
  });

  it('pins the tree ranges and keeps every per-child ceiling within the tree ceiling', () => {
    expect(SUBAGENT_SETTINGS_LIMITS.maxDepth).toEqual({ max: 8, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxInvocations).toEqual({ max: 1000, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxConcurrentWork).toEqual({ max: 20, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxTreeOutputTokens).toEqual({
      max: 131_072_000,
      min: 1024,
    });
    // The largest tree budget is every admissible invocation spending the
    // largest per-child allocation, and it fits the budget row's int4 columns.
    expect(SUBAGENT_SETTINGS_LIMITS.maxTreeOutputTokens.max).toBe(
      SUBAGENT_SETTINGS_LIMITS.maxInvocations.max *
        SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens.max
    );
    expect(SUBAGENT_SETTINGS_LIMITS.maxTreeOutputTokens.max).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens.max).toBeLessThanOrEqual(
      SUBAGENT_SETTINGS_LIMITS.maxTreeOutputTokens.max
    );
  });

  it('exports no tree-limit CONSTANT: every consumer reads the request settings', () => {
    // The tree ceilings used to be the frozen `DELEGATION_LIMITS`; a consumer
    // reading a constant instead of the request's settings is now a compile
    // error because the export is gone, and this pins the runtime surface.
    expect('DELEGATION_LIMITS' in contract).toBe(false);
  });

  it('runs a child without a wall-clock deadline by default (Off = the longest timer Node arms)', () => {
    expect(NODE_TIMER_MAX_MS).toBe(2 ** 31 - 1);
    expect(resolveChildTaskTimeoutMs(DEFAULT_RUNTIME_SUBAGENT_SETTINGS)).toBe(NODE_TIMER_MAX_MS);
    expect(
      resolveChildTaskTimeoutMs({ ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildRuntimeMs: 90_000 })
    ).toBe(90_000);
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildRuntimeMs).toEqual({
      max: NODE_TIMER_MAX_MS,
      min: 1000,
    });
  });

  it('pins the per-child validation ranges', () => {
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildSteps).toEqual({ max: 1000, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.synthesisOutputTokens).toEqual({ max: 8192, min: 256 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens).toEqual({ max: 131_072, min: 1024 });
  });

  it('answers an ABSENT field with the defaults (the documented absent-field contract)', () => {
    expect(parseRuntimeSubagentSettings(undefined)).toEqual(DEFAULT_RUNTIME_SUBAGENT_SETTINGS);
  });

  it('accepts a value inside every range unchanged', () => {
    const value = {
      maxChildOutputTokens: 65_536,
      maxChildRuntimeMs: 3_600_000,
      maxChildSteps: 1000,
      maxConcurrentWork: 20,
      maxDepth: 1,
      maxInvocations: 1000,
      maxStepOutputTokens: 4096,
      maxTreeOutputTokens: 65_536,
      synthesisOutputTokens: 256,
    };
    expect(parseRuntimeSubagentSettings(value)).toEqual(value);
  });

  it.each([
    ['null', null],
    ['a string', 'lots'],
    [
      'a missing field',
      { maxChildSteps: 32, maxStepOutputTokens: 8192, synthesisOutputTokens: 2048 },
    ],
    [
      'a runtime below one second',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildRuntimeMs: 999 },
    ],
    [
      'a runtime Node would fire immediately',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildRuntimeMs: NODE_TIMER_MAX_MS + 1 },
    ],
    [
      'an infinite runtime (Off is null, never Infinity)',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildRuntimeMs: Number.POSITIVE_INFINITY },
    ],
    ['an unknown field', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxTurns: 9 }],
    ['zero descendant levels', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 0 }],
    ['nine descendant levels', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 9 }],
    ['zero invocations', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxInvocations: 0 }],
    ['1001 invocations', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxInvocations: 1001 }],
    ['zero concurrent work', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxConcurrentWork: 0 }],
    ['21 concurrent operations', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxConcurrentWork: 21 }],
    [
      'a tree budget above the int4 ceiling',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxTreeOutputTokens: 131_072_001 },
    ],
    [
      'a child output budget larger than the tree output budget',
      {
        ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        maxChildOutputTokens: 65_536,
        maxTreeOutputTokens: 32_768,
      },
    ],
    ['zero steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 0 }],
    ['1001 steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 1001 }],
    ['fractional steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 2.5 }],
    ['synthesis below 256', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, synthesisOutputTokens: 255 }],
    ['synthesis above 8192', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, synthesisOutputTokens: 8193 }],
    ['NaN', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildOutputTokens: Number.NaN }],
    ['a numeric string', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: '32' }],
    [
      'synthesis larger than the child output budget',
      {
        ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        maxChildOutputTokens: 1024,
        synthesisOutputTokens: 2048,
      },
    ],
    [
      'a step budget larger than the child output budget',
      {
        ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        maxChildOutputTokens: 1024,
        maxStepOutputTokens: 8192,
      },
    ],
  ])('THROWS on %s instead of coercing', (_label, value) => {
    expect(() => parseRuntimeSubagentSettings(value)).toThrow(RuntimeSubagentSettingsError);
    expect(() => parseRuntimeSubagentSettings(value)).toThrow(/Subagent settings are malformed/);
  });

  describe('applyTurnSubagentLimits', () => {
    // A later leg of one turn: the request lowered invocations and raised depth,
    // but the turn's budget row holds what the first admission stored.
    const request = {
      ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      maxChildRuntimeMs: 60_000,
      maxChildSteps: 12,
      maxConcurrentWork: 3,
      maxDepth: 5,
      maxInvocations: 2,
    };
    const turn = {
      maxChildOutputTokens: 16_384,
      maxChildSteps: 40,
      maxDepth: 1,
      maxInvocations: 8,
      maxStepOutputTokens: 4096,
      maxTreeOutputTokens: 131_072,
      synthesisOutputTokens: 1024,
    };

    it("takes every turn-scoped limit from the turn's row and every per-request one from the request", () => {
      expect(applyTurnSubagentLimits(request, turn)).toEqual({
        ...turn,
        maxChildRuntimeMs: 60_000,
        maxConcurrentWork: 3,
      });
    });

    it('is the request itself before the turn has a row (the first leg)', () => {
      expect(applyTurnSubagentLimits(request, undefined)).toBe(request);
    });

    it('THROWS on a stored row the contract rejects instead of trusting it', () => {
      expect(() =>
        applyTurnSubagentLimits(request, { ...turn, maxTreeOutputTokens: 1024 })
      ).toThrow(/maxChildOutputTokens must not exceed maxTreeOutputTokens/);
    });
  });

  it('names the tree rule a child output budget breaks', () => {
    expect(() =>
      parseRuntimeSubagentSettings({
        ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
        maxChildOutputTokens: 65_536,
        maxTreeOutputTokens: 32_768,
      })
    ).toThrow('maxChildOutputTokens: maxChildOutputTokens must not exceed maxTreeOutputTokens');
  });
});
