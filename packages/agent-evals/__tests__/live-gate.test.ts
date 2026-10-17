import { expect, test } from 'vitest';
import { assertLiveAllowed } from '../src/live-gate.js';

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
