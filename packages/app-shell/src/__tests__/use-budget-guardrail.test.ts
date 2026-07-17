import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useDailySpendMock } = vi.hoisted(() => ({
  useDailySpendMock: vi.fn(),
}));

vi.mock('../cost-tracking/use-daily-spend', () => ({
  useDailySpend: useDailySpendMock,
}));

import {
  __resetAssistantBudgetPreferencesStoreForTests,
  useAssistantBudgetPreferencesStore,
} from '@brainstrike/preferences/stores/assistant-budget-preferences-store';
import type { DailySpendState } from '../cost-tracking/use-daily-spend';
import { useBudgetGuardrailBinding } from '../hooks/use-budget-guardrail';

function spendState(overrides: Partial<DailySpendState> = {}): DailySpendState {
  return {
    available: true,
    error: null,
    loading: false,
    refresh: vi.fn(async () => undefined),
    spend: { estimatedUsd: 1, exactUsd: 4, totalUsd: 5, unpricedModels: [] },
    ...overrides,
  };
}

describe('useBudgetGuardrailBinding', () => {
  beforeEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
    useDailySpendMock.mockReset();
    useDailySpendMock.mockReturnValue(spendState());
  });

  afterEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
  });

  it('is null when no daily cap is configured (feature off by default)', () => {
    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current).toBeNull();
  });

  it('is null when the durable spend capability is absent (web)', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    useDailySpendMock.mockReturnValue(spendState({ available: false, spend: null }));

    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current).toBeNull();
  });

  it('is null while spend is still loading (no premature verdicts)', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    useDailySpendMock.mockReturnValue(spendState({ loading: true, spend: null }));

    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current).toBeNull();
  });

  it('is null when the spend query errored, and the failure is not silent', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    useDailySpendMock.mockReturnValue(
      spendState({ error: new Error('query failed'), spend: null })
    );

    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current).toBeNull();
  });

  it('composes status from the cap and the derived spend (under cap)', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(10);
    useDailySpendMock.mockReturnValue(
      spendState({
        spend: { estimatedUsd: 1.5, exactUsd: 4, totalUsd: 5.5, unpricedModels: ['ollama::x'] },
      })
    );

    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current).toEqual(
      expect.objectContaining({
        overridden: false,
        status: {
          capUsd: 10,
          estimatedUsd: 1.5,
          overCap: false,
          spentUsd: 4,
          unpricedModelCount: 1,
        },
      })
    );
  });

  it('flags overCap when the total reaches the cap (>= boundary)', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(5);
    useDailySpendMock.mockReturnValue(
      spendState({ spend: { estimatedUsd: 1, exactUsd: 4, totalUsd: 5, unpricedModels: [] } })
    );

    const { result } = renderHook(() => useBudgetGuardrailBinding());
    expect(result.current?.status.overCap).toBe(true);
  });

  it('override() flips the session override and sticks across re-renders', () => {
    useAssistantBudgetPreferencesStore.getState().setDailyCapUsd(5);
    const { rerender, result } = renderHook(() => useBudgetGuardrailBinding());

    expect(result.current?.overridden).toBe(false);
    act(() => {
      result.current?.override();
    });
    expect(result.current?.overridden).toBe(true);

    rerender();
    expect(result.current?.overridden).toBe(true);
  });
});
