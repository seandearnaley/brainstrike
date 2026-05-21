import { describe, expect, it } from 'vitest';
import {
  createRuntimeHostPlatformStatus,
  deriveRuntimeHostPlatformState,
} from '../../platform/runtime-host-state';

function createStatus(
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping',
  active = false
) {
  return {
    active,
    lastError: state === 'error' ? 'boom' : null,
    runtimeId: `embedding-host:${state}`,
    runtimeKind: 'embedding-host' as const,
    state,
  };
}

describe('runtime host platform state', () => {
  it('derives observable platform states from canonical runtime status', () => {
    expect(deriveRuntimeHostPlatformState(createStatus('stopped'))).toBe('stopped');
    expect(deriveRuntimeHostPlatformState(createStatus('starting'))).toBe('starting');
    expect(deriveRuntimeHostPlatformState(createStatus('running'))).toBe('idle');
    expect(deriveRuntimeHostPlatformState(createStatus('running', true))).toBe('active');
    expect(deriveRuntimeHostPlatformState(createStatus('stopping'))).toBe('stopping');
    expect(deriveRuntimeHostPlatformState(createStatus('error'))).toBe('failed');
  });

  it('supports explicit control states for reset, restart, and dispose observability', () => {
    const runningStatus = createStatus('running');

    expect(
      createRuntimeHostPlatformStatus(runningStatus, { controlState: 'resetting' }).state
    ).toBe('resetting');
    expect(
      createRuntimeHostPlatformStatus(runningStatus, { controlState: 'restarting' }).state
    ).toBe('restarting');
    expect(createRuntimeHostPlatformStatus(runningStatus, { controlState: 'disposed' }).state).toBe(
      'disposed'
    );
  });

  it('keeps snapshots machine-readable and includes pending request counts', () => {
    expect(
      createRuntimeHostPlatformStatus(createStatus('running', true), {
        pendingRequestCount: 3,
      })
    ).toEqual({
      active: true,
      lastError: null,
      pendingRequestCount: 3,
      runtimeId: 'embedding-host:running',
      runtimeKind: 'embedding-host',
      sourceState: 'running',
      state: 'active',
    });
  });
});
