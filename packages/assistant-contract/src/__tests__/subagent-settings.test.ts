import { describe, expect, it } from 'vitest';
import { DELEGATION_LIMITS } from '../delegation-limits.js';
import {
  DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
  parseRuntimeSubagentSettings,
  RuntimeSubagentSettingsError,
  SUBAGENT_SETTINGS_LIMITS,
} from '../subagent-settings.js';

describe('RuntimeSubagentSettings', () => {
  it('ships the raised defaults the swarm runs need', () => {
    expect(DEFAULT_RUNTIME_SUBAGENT_SETTINGS).toEqual({
      maxChildOutputTokens: 32_768,
      maxChildSteps: 32,
      maxStepOutputTokens: 8192,
      synthesisOutputTokens: 2048,
    });
  });

  it('pins the validation ranges and keeps the per-child ceiling under the tree ceiling', () => {
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildSteps).toEqual({ max: 64, min: 1 });
    expect(SUBAGENT_SETTINGS_LIMITS.synthesisOutputTokens).toEqual({ max: 8192, min: 256 });
    expect(SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens.max).toBe(
      DELEGATION_LIMITS.maxTreeOutputTokens
    );
  });

  it('answers an ABSENT field with the defaults (the documented absent-field contract)', () => {
    expect(parseRuntimeSubagentSettings(undefined)).toEqual(DEFAULT_RUNTIME_SUBAGENT_SETTINGS);
  });

  it('accepts a value inside every range unchanged', () => {
    const value = {
      maxChildOutputTokens: 65_536,
      maxChildSteps: 64,
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
    ['an unknown field', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxDepth: 9 }],
    ['zero steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 0 }],
    ['65 steps', { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS, maxChildSteps: 65 }],
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

  it('DELEGATION_LIMITS carries only the tree-wide ceilings', () => {
    expect(DELEGATION_LIMITS).toEqual({
      maxConcurrentWork: 2,
      maxDepth: 3,
      maxInvocations: 8,
      maxTreeOutputTokens: 131_072,
    });
  });
});
