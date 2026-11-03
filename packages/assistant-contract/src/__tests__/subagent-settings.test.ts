import { describe, expect, it } from 'vitest';
import * as contract from '../index.js';
import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  NODE_TIMER_MAX_MS,
  parseRuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
  resolveChildTaskTimeoutMs,
  SUBAGENT_SETTINGS_LIMITS,
} from '../subagent-settings.js';

describe('RuntimeSubagentSettings', () => {
  it('ships the raised defaults the swarm runs need, with every output cap Off', () => {
    expect(DEFAULT_RUNTIME_SUBAGENT_SETTINGS).toEqual({
      maxChildRuntimeMs: null,
      maxChildSteps: 100,
      maxConcurrentWork: 6,
      maxDepth: 3,
      maxInvocations: 200,
      maxStepOutputTokens: null,
      synthesisOutputTokens: null,
    });
  });

  it('pins the tree ranges', () => {
    expect(SUBAGENT_SETTINGS_LIMITS.maxDepth).toEqual({ max: 8, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxInvocations).toEqual({ max: 1000, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxConcurrentWork).toEqual({ max: 20, min: 1 });
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
    expect(SUBAGENT_SETTINGS_LIMITS.maxStepOutputTokens).toEqual({ max: 65_536, min: 256 });
  });

  it('answers an ABSENT field with the defaults (the documented absent-field contract)', () => {
    expect(parseRuntimeSubagentSettings(undefined)).toEqual(DEFAULT_RUNTIME_SUBAGENT_SETTINGS);
  });

  it('accepts a value inside every range unchanged', () => {
    const value = {
      maxChildRuntimeMs: 3_600_000,
      maxChildSteps: 1000,
      maxConcurrentWork: 20,
      maxDepth: 1,
      maxInvocations: 1000,
      maxStepOutputTokens: 4096,
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
    ['zero steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 0 }],
    ['1001 steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 1001 }],
    ['fractional steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 2.5 }],
    ['synthesis below 256', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, synthesisOutputTokens: 255 }],
    ['synthesis above 8192', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, synthesisOutputTokens: 8193 }],
    ['NaN', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxStepOutputTokens: Number.NaN }],
    [
      'a step cap above 65536',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxStepOutputTokens: 65_537 },
    ],
    [
      'a removed output budget',
      { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildOutputTokens: 32_768 },
    ],
    ['a numeric string', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: '32' }],
  ])('THROWS on %s instead of coercing', (_label, value) => {
    expect(() => parseRuntimeSubagentSettings(value)).toThrow(RuntimeSubagentSettingsError);
    expect(() => parseRuntimeSubagentSettings(value)).toThrow(/Subagent settings are malformed/u);
  });
});
