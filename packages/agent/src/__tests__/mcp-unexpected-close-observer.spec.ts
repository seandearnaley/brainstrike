import { describe, expect, it } from 'vitest';
import { notifyUnexpectedClose } from '../mcp/unexpected-close-observer';

describe('notifyUnexpectedClose', () => {
  it('handles an asynchronously rejecting observer without an unhandled rejection', async () => {
    expect(() =>
      notifyUnexpectedClose(async () => {
        throw new Error('observer failed asynchronously');
      }, 'streamable-http')
    ).not.toThrow();

    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
