import { describe, expect, it } from 'vitest';
import { messageMatchesListScope } from '../memory-query-helpers';

describe('messageMatchesListScope', () => {
  it('accepts an identity when no thread or resource scope is requested', () => {
    expect(messageMatchesListScope({ resourceId: null, threadId: null }, {})).toBe(true);
  });

  it('requires both requested scopes to match', () => {
    const args = { resourceId: 'resource-a', threadIds: ['thread-a', 'thread-b'] };

    expect(messageMatchesListScope({ resourceId: 'resource-a', threadId: 'thread-b' }, args)).toBe(
      true
    );
    expect(messageMatchesListScope({ resourceId: 'resource-b', threadId: 'thread-b' }, args)).toBe(
      false
    );
    expect(messageMatchesListScope({ resourceId: 'resource-a', threadId: 'thread-c' }, args)).toBe(
      false
    );
  });

  it('rejects a missing thread identity and every identity for an empty thread set', () => {
    expect(messageMatchesListScope({ resourceId: 'resource-a' }, { threadIds: ['thread-a'] })).toBe(
      false
    );
    expect(
      messageMatchesListScope({ resourceId: 'resource-a', threadId: 'thread-a' }, { threadIds: [] })
    ).toBe(false);
  });
});
