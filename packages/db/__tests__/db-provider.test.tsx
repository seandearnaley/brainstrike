import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';

// Simple wrapper component for renderHook
function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
}

describe('DbProvider', () => {
  it('exposes FileRecordRepository via context', () => {
    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });
    expect(result.current).toBeDefined();
  });

  it('throws when hook used outside provider', () => {
    expect(() => renderHook(() => useFileRecordRepository())).toThrow(
      /must be used within a DbProvider/
    );
  });
});
