import { describe, expect, it } from 'vitest';
import { assertEmbeddingModelSwitchMemoryProbeWorkerMessage } from '../embedding-model-switch-memory-probe-contract';

function expectValidWorkerMessage(value: unknown): void {
  expect(() => assertEmbeddingModelSwitchMemoryProbeWorkerMessage(value)).not.toThrow();
}

describe('BST-369 probe worker message contract', () => {
  it('accepts every valid worker message variant', () => {
    expectValidWorkerMessage({ type: 'ready' });
    expectValidWorkerMessage({ message: 'probe failed visibly', type: 'error' });
    expectValidWorkerMessage({
      allocationCount: 4,
      disposedModels: ['wasm-a'],
      liveBytes: 8 * 1024 * 1024,
      residentModels: ['wasm-b'],
      type: 'state',
    });
  });

  it.each([
    { name: 'null', value: null },
    { name: 'array', value: [] },
    { name: 'scalar', value: 'ready' },
  ])('rejects a non-record $name message', ({ value }) => {
    expect(() => assertEmbeddingModelSwitchMemoryProbeWorkerMessage(value)).toThrow(
      'Embedding model-switch probe worker message must be an object.'
    );
  });

  it.each([{ message: '', type: 'error' }, { type: 'error' }])(
    'rejects an error message without non-empty text',
    (value) => {
      expect(() => assertEmbeddingModelSwitchMemoryProbeWorkerMessage(value)).toThrow(
        'Embedding model-switch probe error requires a message.'
      );
    }
  );

  it('rejects an unknown message type', () => {
    expect(() => assertEmbeddingModelSwitchMemoryProbeWorkerMessage({ type: 'complete' })).toThrow(
      'Embedding model-switch probe worker message has an invalid type.'
    );
  });

  it.each([
    {
      allocationCount: -1,
      disposedModels: [],
      liveBytes: 0,
      residentModels: [],
      type: 'state',
    },
    {
      allocationCount: 1,
      disposedModels: [],
      liveBytes: 0.5,
      residentModels: [],
      type: 'state',
    },
    {
      allocationCount: 1,
      disposedModels: [],
      liveBytes: 0,
      residentModels: 'wasm-a',
      type: 'state',
    },
    {
      allocationCount: 1,
      disposedModels: [],
      liveBytes: 0,
      residentModels: [''],
      type: 'state',
    },
    {
      allocationCount: 1,
      disposedModels: 'wasm-a',
      liveBytes: 0,
      residentModels: [],
      type: 'state',
    },
    {
      allocationCount: 1,
      disposedModels: [''],
      liveBytes: 0,
      residentModels: [],
      type: 'state',
    },
  ])('rejects malformed worker state %#', (value) => {
    expect(() => assertEmbeddingModelSwitchMemoryProbeWorkerMessage(value)).toThrow(
      'Embedding model-switch probe worker state is malformed.'
    );
  });
});
