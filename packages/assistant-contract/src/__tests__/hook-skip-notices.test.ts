import { expect, test } from 'vitest';
import { describeHookSkip } from '../hook-skip-notices.js';

const remedy = 'Review it in Settings > Hooks.';

test('a file that trusting would run names the surface remedy', () => {
  expect(
    describeHookSkip(
      { detail: 'not trusted', path: '/w/.brainstrike/hooks.json', reason: 'untrusted' },
      remedy
    )
  ).toEqual({
    detail: '/w/.brainstrike/hooks.json: not trusted — Review it in Settings > Hooks.',
    label: 'Project hooks not trusted',
  });
  expect(
    describeHookSkip(
      {
        detail: 'changed since it was trusted',
        path: '/w/.brainstrike/hooks.json',
        reason: 'changed',
      },
      remedy
    )
  ).toEqual({
    detail:
      '/w/.brainstrike/hooks.json: changed since it was trusted — Review it in Settings > Hooks.',
    label: 'Project hooks changed since trusted',
  });
});

test('a file trust cannot fix carries no remedy', () => {
  expect(
    describeHookSkip(
      {
        detail: 'PreToolUse must be a list',
        path: '/home/.brainstrike/hooks.json',
        reason: 'invalid',
      },
      remedy
    )
  ).toEqual({
    detail: '/home/.brainstrike/hooks.json: PreToolUse must be a list',
    label: 'Hooks file invalid',
  });
});
