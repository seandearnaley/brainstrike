import { describe, expect, it, vi } from 'vitest';
import { retireRootIngestion } from '../file-ingestion';

type Root = Parameters<typeof retireRootIngestion>[0];

function root(failing: { readonly inference?: boolean; readonly runtime?: boolean } = {}) {
  const order: string[] = [];
  const step = (name: string, fails = false) =>
    vi.fn(async () => {
      order.push(name);
      if (fails) {
        throw new Error(`${name} retirement failed`);
      }
    });
  const parts = {
    current: { reject: vi.fn(), resolve: vi.fn() },
    inference: { close: step('inference', failing.inference) },
    lease: { retire: step('lease'), revoke: vi.fn(() => order.push('revoke')) },
    runtime: { close: step('runtime', failing.runtime) },
  };
  return { order, parts, root: parts as unknown as Root };
}

describe("a root's ingestion retires every owner it holds", () => {
  it('in order: the runtime, its inference, then the lease, failing the waiting scan', async () => {
    const { order, parts, root: retiring } = root();
    await retireRootIngestion(retiring);
    expect(order).toEqual(['runtime', 'inference', 'revoke', 'lease']);
    expect(parts.current.reject).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'File ingestion retired.', name: 'AbortError' })
    );
  });

  it('closes the inference and the lease even when the runtime fails to retire', async () => {
    const { order, root: retiring } = root({ runtime: true });
    await expect(retireRootIngestion(retiring)).rejects.toThrow('runtime retirement failed');
    expect(order).toEqual(['runtime', 'inference', 'revoke', 'lease']);
  });

  it('reports every failure together', async () => {
    const { order, root: retiring } = root({ inference: true, runtime: true });
    const failure = await retireRootIngestion(retiring).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      'runtime retirement failed',
      'inference retirement failed',
    ]);
    expect(order).toEqual(['runtime', 'inference', 'revoke', 'lease']);
  });
});
