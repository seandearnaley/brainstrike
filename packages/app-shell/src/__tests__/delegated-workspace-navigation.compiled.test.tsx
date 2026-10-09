// @vitest-environment jsdom
import {
  DelegatedApprovalOwnerContext,
  SubagentConversationPresentationContext,
} from '@brainstrike/assistant-ui';
import { act, cleanup, render } from '@testing-library/react';
import { use } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishDelegatedColorRefresh } from '../delegated-color-refresh';
import { DelegatedConversationRootsProvider } from '../delegated-conversation-root';
import { DelegatedWorkspaceNavigation } from '../delegated-workspace-navigation';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@brainstrike/db/react', () => ({
  useDbProviderError: () => null,
  useOptionalPGliteDatabase: () => db,
  usePGliteDatabase: () => db,
}));

afterEach(cleanup);

describe('DelegatedWorkspaceNavigation under the React Compiler', () => {
  it('hands consumers new resolvers after a committed color refresh', () => {
    const presentations: unknown[] = [];
    const approvalOwners: unknown[] = [];
    function Probe() {
      presentations.push(use(SubagentConversationPresentationContext));
      approvalOwners.push(use(DelegatedApprovalOwnerContext));
      return null;
    }
    render(
      <DelegatedConversationRootsProvider>
        <DelegatedWorkspaceNavigation ownerResourceId="owner" rootThreadId="root">
          <Probe />
        </DelegatedWorkspaceNavigation>
      </DelegatedConversationRootsProvider>
    );
    const before = { approvalOwner: approvalOwners.at(-1), presentation: presentations.at(-1) };
    expect(before.presentation).toBeTypeOf('function');
    expect(before.approvalOwner).toBeTypeOf('function');

    act(publishDelegatedColorRefresh);

    expect(presentations.at(-1)).toBeTypeOf('function');
    expect(presentations.at(-1)).not.toBe(before.presentation);
    expect(approvalOwners.at(-1)).not.toBe(before.approvalOwner);
  });
});
