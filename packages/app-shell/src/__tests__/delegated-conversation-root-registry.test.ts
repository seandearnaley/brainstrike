import { describe, expect, it, vi } from 'vitest';
import { createDelegatedConversationRootRegistry } from '../delegated-conversation-root-registry';
import { delegatedUpdate } from './helpers/delegated-conversation-fixtures';

const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };

describe('delegated root view lifetime', () => {
  it('does not allocate during snapshot reads and publishes creation from subscription', () => {
    const registry = createDelegatedConversationRootRegistry();
    expect(registry.get(scope)).toBeUndefined();
    expect(registry.get(scope)).toBeUndefined();
    const listener = vi.fn();
    const release = registry.subscribe(scope, listener);
    expect(registry.get(scope)).toBeDefined();
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    expect(registry.get(scope)).toBeUndefined();
  });
  it('retains child output while another owner/view is mounted and clears it after the last release', () => {
    const registry = createDelegatedConversationRootRegistry();
    const ownerRelease = registry.subscribe(scope, vi.fn());
    const viewRelease = registry.subscribe(scope, vi.fn());
    const root = registry.get(scope);
    expect(root).toBeDefined();
    root?.onDelegatedConversation(delegatedUpdate('child'));
    ownerRelease();
    expect(registry.get(scope)).toBe(root);
    expect(root?.store.getSnapshot().size).toBe(1);
    viewRelease();
    expect(registry.get(scope)).toBeUndefined();
    expect(root?.store.getSnapshot().size).toBe(0);
  });
  it('does not let obsolete cleanup remove a new owner or another resource', () => {
    const registry = createDelegatedConversationRootRegistry();
    const oldRelease = registry.subscribe(scope, vi.fn());
    const oldRoot = registry.get(scope);
    oldRelease();
    const release = registry.subscribe(scope, vi.fn());
    const nextRoot = registry.get(scope);
    const other = { ...scope, ownerResourceId: 'other' };
    const releaseOther = registry.subscribe(other, vi.fn());
    oldRelease();
    expect(nextRoot).not.toBe(oldRoot);
    expect(registry.get(scope)).toBe(nextRoot);
    release();
    expect(registry.get(other)).toBeDefined();
    releaseOther();
    expect(registry.get(other)).toBeUndefined();
  });
});
