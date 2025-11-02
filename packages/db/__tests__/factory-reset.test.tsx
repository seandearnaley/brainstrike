import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DbProvider, useFactoryReset, useFileRecordRepository } from '../src/db-provider';
import * as wasmLoaderModule from '../src/wasm-loader';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

describe('DbProvider factoryReset', () => {
  it('exposes a factoryReset function and runs without throwing', async () => {
    const createdDbs: Array<{ close: () => Promise<void> }> = [];
    const originalCreate = wasmLoaderModule.wasmLoader.createPGlite.bind(
      wasmLoaderModule.wasmLoader
    );
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockImplementation(async (path) => {
      const db = await originalCreate(
        typeof path === 'string' ? `${path}-factory-reset` : 'memory://factory-reset'
      );
      createdDbs.push(db as { close: () => Promise<void> });
      return db;
    });

    const { result } = renderHook(
      () => ({
        repo: useFileRecordRepository(),
        reset: useFactoryReset(),
      }),
      { wrapper }
    );

    // Wait for factoryReset to be available (repo may still be null before lazy init completes)
    await waitFor(
      () => {
        expect(result.current.reset).not.toBeNull();
      },
      { timeout: 5000 }
    );

    // Perform factory reset; should not throw
    await act(async () => {
      if (result.current.reset) {
        await result.current.reset();
      }
    });

    // If we got here without throwing, the test passes
    expect(result.current.reset).toBeDefined();

    await Promise.allSettled(createdDbs.map((db) => db.close()));
  }, 15000); // Increase timeout to 15s for CI environment
});
