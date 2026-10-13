import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  closeQueryEmbeddingRuntimeOwner,
  createQueryEmbeddingRuntimeOwner,
  runOwnedQueryEmbeddingInference,
} from '../../../renderer/components/embedding-host-query-owner';

function createHeldInference() {
  const owner = createQueryEmbeddingRuntimeOwner(undefined);
  const execution = Promise.withResolvers<number[]>();
  const physical = Promise.withResolvers<void>();
  const retire = vi.fn(() => physical.promise);
  const settled = vi.fn();
  const result = runOwnedQueryEmbeddingInference(owner, () => execution.promise).then(
    (value) => {
      settled();
      return value;
    },
    (error: unknown) => {
      settled();
      return error;
    }
  );
  onTestFinished(async () => {
    execution.resolve([1]);
    physical.resolve();
    await result;
  });
  return { execution, owner, physical, result, retire, settled };
}

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

describe('hidden inference physical owner retirement', () => {
  it('fences immediately and starts physical retirement before waiting for abort-resistant execution', async () => {
    const run = createHeldInference();
    const closing = closeQueryEmbeddingRuntimeOwner(run.owner, run.retire, {
      current: 'runtime-test',
    });
    expect(run.owner.closed).toBe(true);
    expect(run.owner.inferenceController.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(run.retire).toHaveBeenCalledOnce();
    expect(run.settled).not.toHaveBeenCalled();
    run.execution.resolve([1]);
    run.physical.resolve();
    await closing;
  });

  it('keeps execution rejection private until the physical pool join and preserves its independent error', async () => {
    const run = createHeldInference();
    const failure = new Error('Worker terminated');
    const closing = closeQueryEmbeddingRuntimeOwner(run.owner, run.retire, {
      current: 'runtime-test',
    });
    run.execution.reject(failure);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(run.settled).not.toHaveBeenCalled();
    run.physical.resolve();
    await expect(run.result).resolves.toBe(failure);
    await closing;
  });

  it('retains the first physical join for concurrent closes and preserves inference and retirement failures', async () => {
    const run = createHeldInference();
    const inferenceFailure = new DOMException('Independent execution abort', 'AbortError');
    const retirementFailure = new Error('Physical pool retirement failed');
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();
    const first = closeQueryEmbeddingRuntimeOwner(run.owner, run.retire, {
      current: 'runtime-test',
    }).then(
      () => {
        firstSettled();
        return null;
      },
      (error: unknown) => {
        firstSettled();
        return error;
      }
    );
    const second = closeQueryEmbeddingRuntimeOwner(run.owner, run.retire, {
      current: 'runtime-test',
    }).then(
      () => {
        secondSettled();
        return null;
      },
      (error: unknown) => {
        secondSettled();
        return error;
      }
    );
    run.execution.reject(inferenceFailure);
    await Promise.resolve();
    await Promise.resolve();
    expect(run.retire).toHaveBeenCalledOnce();
    expect(firstSettled).not.toHaveBeenCalled();
    expect(secondSettled).not.toHaveBeenCalled();
    expect(run.settled).not.toHaveBeenCalled();
    run.physical.reject(retirementFailure);
    expect(failures(await run.result)).toEqual([inferenceFailure, retirementFailure]);
    expect(failures(await first)).toContain(retirementFailure);
    expect(failures(await second)).toContain(retirementFailure);
    expect(run.retire).toHaveBeenCalledOnce();
  });
});
