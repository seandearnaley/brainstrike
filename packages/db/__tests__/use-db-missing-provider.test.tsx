// @vitest-environment jsdom
import type { LogRecord } from '@brainstrike/logging';
import { addLogListener, LogLevel, resetLogger } from '@brainstrike/logging';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as useDbModule from '../src/use-db';
import {
  useClearAllData,
  useClearQueuesAndEmbeddingSets,
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  useDrizzleDb,
  useEmbeddingSetsRepository,
  useFactoryReset,
  useFileChunkRepository,
  useFileRecordRepository,
  useLiveQueryDrainRegistry,
  useOptionalPGliteDatabase,
  usePGliteDatabase,
  useVectorEnabled,
  useViewFilterPresetsRepository,
} from '../src/use-db';

// Contract test for the missing-provider behavior of every DbProvider
// consumer hook. Each hook belongs to exactly one class:
//   - throw: state accessors with no meaningful no-provider value
//   - warn:  nullable accessors that return null but must leave a trace,
//            so a missing provider is never mistaken for pre-init state
//            (AGENTS.md: no silent fallbacks)
//   - silent: hooks whose contract is explicitly optional —
//            useOptionalPGliteDatabase, and useLiveQueryDrainRegistry
//            (BST-1329: no provider means no drain owner, by design)
// A new hook must land in one of these tables.

const THROW_HOOKS = [
  ['useDbInitializationStatus', useDbInitializationStatus],
  ['useDbInitializing', useDbInitializing],
  ['useDbProviderError', useDbProviderError],
  ['useVectorEnabled', useVectorEnabled],
] as const;

const WARN_HOOKS = [
  ['useClearAllData', useClearAllData],
  ['useClearQueuesAndEmbeddingSets', useClearQueuesAndEmbeddingSets],
  ['useDrizzleDb', useDrizzleDb],
  ['useEmbeddingSetsRepository', useEmbeddingSetsRepository],
  ['useFactoryReset', useFactoryReset],
  ['useFileChunkRepository', useFileChunkRepository],
  ['useFileRecordRepository', useFileRecordRepository],
  ['usePGliteDatabase', usePGliteDatabase],
  ['useViewFilterPresetsRepository', useViewFilterPresetsRepository],
] as const;

describe('use-db hooks outside a DbProvider', () => {
  const captured: LogRecord[] = [];
  let unsubscribe: () => void;

  beforeEach(() => {
    resetLogger();
    captured.length = 0;
    unsubscribe = addLogListener((record) => {
      if (record.scope === 'DbProvider') {
        captured.push(record);
      }
    });
  });

  afterEach(() => {
    unsubscribe();
  });

  it('classifies every exported hook', () => {
    const exported = Object.keys(useDbModule)
      .filter((name) => name.startsWith('use'))
      .sort();
    const classified: string[] = [...THROW_HOOKS, ...WARN_HOOKS]
      .map(([name]) => name)
      .concat('useLiveQueryDrainRegistry', 'useOptionalPGliteDatabase')
      .sort();
    expect(exported).toEqual(classified);
  });

  it.each(THROW_HOOKS)('%s throws', (hookName, hook) => {
    expect(() => {
      renderHook(() => hook());
    }).toThrow(`${hookName} must be used within a DbProvider`);
  });

  it.each(WARN_HOOKS)('%s returns null and warns', (hookName, hook) => {
    const { result } = renderHook(() => hook());

    expect(result.current).toBeNull();
    expect(
      captured.some(
        (record) =>
          record.level === LogLevel.WARN &&
          record.message === `${hookName} must be used within a DbProvider`
      )
    ).toBe(true);
  });

  it('useOptionalPGliteDatabase returns null without logging', () => {
    const { result } = renderHook(() => useOptionalPGliteDatabase());

    expect(result.current).toBeNull();
    expect(captured).toEqual([]);
  });

  it('useLiveQueryDrainRegistry returns null without logging', () => {
    const { result } = renderHook(() => useLiveQueryDrainRegistry());

    expect(result.current).toBeNull();
    expect(captured).toEqual([]);
  });
});
