import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { PGlite } from '@electric-sql/pglite';
import * as migrations from '../src/migrations/bootstrap';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
}

describe('DbProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('exposes FileRecordRepository via context', () => {
    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });
    expect(result.current).toBeDefined();
  });

  it('throws when hook used outside provider', () => {
    expect(() => renderHook(() => useFileRecordRepository())).toThrow(
      /must be used within a DbProvider/
    );
  });

  it('runs migrations on mount and closes db on unmount', () => {
    const migrateSpy = vi
      .spyOn(migrations, 'migrate')
      .mockResolvedValue(undefined as unknown as void);
    const closeSpy = vi
      .spyOn(PGlite.prototype, 'close')
      .mockResolvedValue(undefined as unknown as void);

    const { unmount } = renderHook(() => useFileRecordRepository(), {
      wrapper,
    });

    expect(migrateSpy).toHaveBeenCalledTimes(1);

    unmount();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
