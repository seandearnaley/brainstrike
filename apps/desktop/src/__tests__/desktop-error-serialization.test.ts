import { describe, expect, it } from 'vitest';
import { serializeDesktopError } from '../desktop-error-serialization';

describe('serializeDesktopError', () => {
  it('preserves nested aggregate causes and bounded structured cleanup fields', () => {
    const nestedCause = new AggregateError(
      [{ category: 42, code: null, message: 'nested failure', secret: 'must not leak' }],
      'nested cleanup failed'
    );
    const nested = new AggregateError(
      [
        new Error('assistant stop failed'),
        nestedCause,
        { category: 'transport', code: 'child_alive', message: 'stdio child survived' },
        0,
      ],
      'shutdown cleanup failed'
    );

    expect(serializeDesktopError(nested)).toEqual({
      errors: [
        { message: 'assistant stop failed', name: 'Error', stack: expect.any(String) },
        {
          errors: [{ message: 'nested failure' }],
          message: 'nested cleanup failed',
          name: 'AggregateError',
          stack: expect.any(String),
        },
        {
          category: 'transport',
          code: 'child_alive',
          message: 'stdio child survived',
        },
        { message: '0' },
      ],
      message: 'shutdown cleanup failed',
      name: 'AggregateError',
      stack: expect.any(String),
    });
  });
});
