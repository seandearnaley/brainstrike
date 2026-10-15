// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetDiagnosticSinkHealthStore,
  useDiagnosticSinkHealthStore,
} from '../diagnostics/diagnostic-sink-health-store';

describe('diagnostic-sink-health-store', () => {
  beforeEach(() => {
    resetDiagnosticSinkHealthStore();
  });

  it('starts with no disabled reason', () => {
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
  });

  it('markDisabled records the reason', () => {
    useDiagnosticSinkHealthStore.getState().markDisabled('first failure cause');

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBe('first failure cause');
  });

  it('markDisabled is idempotent: the first reason wins and later calls are ignored', () => {
    useDiagnosticSinkHealthStore.getState().markDisabled('first failure cause');
    useDiagnosticSinkHealthStore.getState().markDisabled('second, unrelated cause');
    useDiagnosticSinkHealthStore.getState().markDisabled('third cause');

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBe('first failure cause');
  });

  it('clear resets the reason so a subsequent markDisabled can record a new first cause', () => {
    useDiagnosticSinkHealthStore.getState().markDisabled('first failure cause');
    useDiagnosticSinkHealthStore.getState().clear();

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();

    useDiagnosticSinkHealthStore.getState().markDisabled('new first cause after clear');
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBe(
      'new first cause after clear'
    );
  });

  it('resetDiagnosticSinkHealthStore restores the initial null state', () => {
    useDiagnosticSinkHealthStore.getState().markDisabled('some cause');
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).not.toBeNull();

    resetDiagnosticSinkHealthStore();

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
  });
});
