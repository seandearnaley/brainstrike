import { addLogListener, type LogRecord } from '@brainstrike/utils/logger';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RootIdentityProvider, useOptionalRootIdentity } from '../roots/root-identity-context';

function wrapper(dbRootIdByAdapterRootId: ReadonlyMap<string, string>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RootIdentityProvider dbRootIdByAdapterRootId={dbRootIdByAdapterRootId}>
        {children}
      </RootIdentityProvider>
    );
  };
}

function dbRootIdOf(record: LogRecord): unknown {
  const payload = record.args[1];
  return payload && typeof payload === 'object'
    ? (payload as { dbRootId?: unknown }).dbRootId
    : undefined;
}

describe('RootIdentityProvider', () => {
  it('inverts the forward map: DB roots.id → adapter rootId', () => {
    // Divergent ids: adapter A1 → DB D1, adapter A2 → DB D2.
    const forward = new Map([
      ['A1', 'D1'],
      ['A2', 'D2'],
    ]);
    const { result } = renderHook(() => useOptionalRootIdentity(), {
      wrapper: wrapper(forward),
    });

    expect(result.current?.resolveAdapterRootId('D1')).toBe('A1');
    expect(result.current?.resolveAdapterRootId('D2')).toBe('A2');
  });

  it('exposes the mounted roots DB ids as workspaceDbRootIds', () => {
    const forward = new Map([
      ['A1', 'D1'],
      ['A2', 'D2'],
    ]);
    const { result } = renderHook(() => useOptionalRootIdentity(), {
      wrapper: wrapper(forward),
    });

    expect([...(result.current?.workspaceDbRootIds ?? [])].sort()).toEqual(['D1', 'D2']);
  });

  it('returns null and logs ONCE for a DB id with no adapter mapping', () => {
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => {
      if (record.args[0] === 'DB root id has no mapped adapter root id') {
        records.push(record);
      }
    });

    const { result } = renderHook(() => useOptionalRootIdentity(), {
      wrapper: wrapper(new Map([['A1', 'D1']])),
    });

    // A unique unmapped id so the module-level warn-once set is fresh for it.
    const unmapped = `UNMAPPED-${Math.random()}`;
    expect(result.current?.resolveAdapterRootId(unmapped)).toBeNull();
    expect(result.current?.resolveAdapterRootId(unmapped)).toBeNull();

    const forThisId = records.filter((record) => dbRootIdOf(record) === unmapped);
    expect(forThisId).toHaveLength(1); // logged once, not twice

    remove();
  });

  it('returns null from useOptionalRootIdentity when no provider is mounted', () => {
    const { result } = renderHook(() => useOptionalRootIdentity());
    expect(result.current).toBeNull();
  });
});
