import { describe, expect, it } from 'vitest';
import { completeToolInputText } from '../stream/tool-input-completion';

describe('append-only tool argument completion', () => {
  it.each([
    ['', { pattern: 'flag' }],
    ['{"pattern":', { pattern: 'flag' }],
    [' {\n "pattern" : ', { pattern: 'flag' }],
    ['{"pattern":"two ', { pattern: 'two words' }],
    ['{"paths":["src",', { paths: ['src', 'tests'] }],
    ['{"limit":1', { limit: 10 }],
    ['{"second":2,"first":1}', { first: 1, second: 2 }],
    ['{"pattern":"\\u0066lag"}', { pattern: 'flag' }],
  ] as const)('preserves the actual JSON value after prefix %s', (prefix, args) => {
    const suffix = completeToolInputText(prefix, args);
    expect(JSON.parse(prefix + suffix)).toEqual(args);
  });

  it.each(['{"different":', '{"pattern":"other"}'])(
    'rejects incompatible authoritative input after %s',
    (prefix) => {
      expect(() => completeToolInputText(prefix, { pattern: 'flag' })).toThrow(
        /Complete tool input/
      );
    }
  );
});
