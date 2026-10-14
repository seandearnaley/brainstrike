// @vitest-environment jsdom
import { addLogListener, resetLogger } from '@brainstrike/logging';
import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { usePGliteLiveQuery } from '../src/use-live-query';

test('a disabled desktop SQL arm needs no database provider or lazy database initialization', () => {
  resetLogger();
  const warnings: string[] = [];
  const unsubscribe = addLogListener((record) => {
    if (record.scope === 'DbProvider') {
      warnings.push(String(record.message));
    }
  });
  try {
    const { result, unmount } = renderHook(() =>
      usePGliteLiveQuery({ enabled: false, query: 'SELECT 1' })
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(warnings).toEqual([]);
    unmount();
  } finally {
    unsubscribe();
  }
});
