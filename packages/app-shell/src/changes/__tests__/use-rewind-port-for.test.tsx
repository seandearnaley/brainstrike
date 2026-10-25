/**
 * A rewind goes to the thread's owner: the host's port for a thread the host
 * owns, Main's legacy service for any other (history's) thread.
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import {
  stubChangesBridge,
  workspaceGitWrapper,
} from '../../__tests__/helpers/workspace-git-services-wrapper';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../../assistant-thread-host-context';
import type { RewindPort } from '../rewind-port';
import { useRewindPortFor } from '../use-rewind-port-for';

const HOST_PORT: RewindPort = {
  apply: vi.fn(),
  conversation: 'branched',
  fileDiff: vi.fn(),
  preview: vi.fn(),
  redo: vi.fn(),
};

const ChangesHost = workspaceGitWrapper({ changes: stubChangesBridge() });

it('routes host-owned threads and refuses unknown ownership without a legacy fallback', () => {
  const host = {
    rewindPort: (threadId: string) => (threadId === 'host-thread' ? HOST_PORT : undefined),
  } as Pick<AssistantThreadHostCapability, 'rewindPort'> as AssistantThreadHostCapability;
  const { result } = renderHook(() => useRewindPortFor(), {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <ChangesHost>
        <AssistantThreadHostContext value={host}>{children}</AssistantThreadHostContext>
      </ChangesHost>
    ),
  });
  expect(result.current?.('host-thread')).toBe(HOST_PORT);
  expect(() => result.current?.('history-thread')).toThrow();
});

it('offers no rewind without the desktop changes bridge (web)', () => {
  const { result } = renderHook(() => useRewindPortFor());
  expect(result.current).toBeNull();
});
