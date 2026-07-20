import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSteerableRun,
  requestRunSteer,
  resetRunSteeringRegistry,
  unregisterSteerableRun,
} from '../../assistant-server/run-steering-registry';

afterEach(() => {
  resetRunSteeringRegistry();
});

describe('run steering registry', () => {
  it('registers a run and flips its control when a steer is requested', () => {
    const control = registerSteerableRun('run-1');
    expect(control.stopRequested()).toBe(false);

    expect(requestRunSteer('run-1')).toBe(true);
    expect(control.stopRequested()).toBe(true);
  });

  it('reports false for an unknown or already-unregistered run (visible no-op, never a throw)', () => {
    expect(requestRunSteer('run-missing')).toBe(false);

    const control = registerSteerableRun('run-2');
    unregisterSteerableRun('run-2');
    expect(requestRunSteer('run-2')).toBe(false);
    // The control handed to the loop stays inert after unregister.
    expect(control.stopRequested()).toBe(false);
  });

  it('throws on a duplicate runId registration (programming error, no silent overwrite)', () => {
    registerSteerableRun('run-3');
    expect(() => registerSteerableRun('run-3')).toThrow(/already registered/i);
  });

  it('a steer requested before unregister stays visible to the held control', () => {
    const control = registerSteerableRun('run-4');
    requestRunSteer('run-4');
    unregisterSteerableRun('run-4');
    expect(control.stopRequested()).toBe(true);
  });
});
