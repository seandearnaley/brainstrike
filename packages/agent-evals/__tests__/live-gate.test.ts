import { describe, expect, test } from 'vitest';
import { assertLiveAllowed, evalRunModel, evalSpendCap } from '../src/live-gate.js';

test('live mode needs --live and BRAINSTRIKE_EVALS_LIVE=1', () => {
  expect(() => assertLiveAllowed(true, { BRAINSTRIKE_EVALS_LIVE: '1' })).not.toThrow();
  expect(() => assertLiveAllowed(false, { BRAINSTRIKE_EVALS_LIVE: '1' })).toThrow(/--live/u);
  expect(() => assertLiveAllowed(true, {})).toThrow(/BRAINSTRIKE_EVALS_LIVE=1/u);
  expect(() => assertLiveAllowed(true, { BRAINSTRIKE_EVALS_LIVE: 'true' })).toThrow(
    /BRAINSTRIKE_EVALS_LIVE=1/u
  );
});

test('live mode never runs in CI, whatever else is set', () => {
  expect(() => assertLiveAllowed(true, { BRAINSTRIKE_EVALS_LIVE: '1', CI: 'true' })).toThrow(
    /never runs in CI/u
  );
});

describe('the spend cap', () => {
  test('a live run is refused without one, naming the flag', () => {
    expect(() => evalSpendCap('live', undefined)).toThrow(/--max-spend-usd/u);
  });

  test('is a positive number of US dollars', () => {
    expect(evalSpendCap('live', '1')).toBe(1);
    expect(evalSpendCap('live', '0.25')).toBe(0.25);
    for (const value of ['0', '-1', 'one', 'Infinity', '']) {
      expect(() => evalSpendCap('live', value), value).toThrow(/positive number of US dollars/u);
    }
  });

  test('scripted and replay runs make no paid call, so they refuse one rather than ignore it', () => {
    expect(evalSpendCap('scripted', undefined)).toBeUndefined();
    expect(evalSpendCap('replay', undefined)).toBeUndefined();
    expect(() => evalSpendCap('scripted', '1')).toThrow(/scripted run makes no paid call/u);
    expect(() => evalSpendCap('replay', '1')).toThrow(/replay run makes no paid call/u);
  });
});

describe('the run’s model', () => {
  test('a live run names its model, which overrides the task’s own', () => {
    expect(evalRunModel('live', 'anthropic::claude-haiku-5-5', 'openai::gpt-6-luna')).toBe(
      'anthropic::claude-haiku-5-5'
    );
    expect(evalRunModel('live', undefined, 'anthropic::claude-sonnet-5')).toBe(
      'anthropic::claude-sonnet-5'
    );
  });

  test('a live run refuses a model that is not Anthropic’s, the task’s own included', () => {
    expect(() => evalRunModel('live', undefined, 'openai::gpt-6-luna')).toThrow(
      /Anthropic models only.*openai::gpt-6-luna/u
    );
    expect(() =>
      evalRunModel('live', 'openrouter::anthropic/claude-sonnet-5', 'openai::gpt-6-luna')
    ).toThrow(/Anthropic models only/u);
    expect(() => evalRunModel('live', 'anthropic::', 'openai::gpt-6-luna')).toThrow(
      /Anthropic models only/u
    );
  });

  test('scripted and replay runs take no model flag', () => {
    expect(evalRunModel('scripted', undefined, 'openai::gpt-6-luna')).toBeUndefined();
    expect(evalRunModel('replay', undefined, 'openai::gpt-6-luna')).toBeUndefined();
    expect(() => evalRunModel('scripted', 'anthropic::claude-haiku-5-5', 'x::y')).toThrow(
      /--model names a live run’s model/u
    );
    expect(() => evalRunModel('replay', 'anthropic::claude-haiku-5-5', 'x::y')).toThrow(
      /--model names a live run’s model/u
    );
  });
});
