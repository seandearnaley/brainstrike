// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { awaitHostDevice, requestHostDeviceResolution } from '../embedding-host-device';
import type { EmbeddingHostStatus } from '../embedding-host-shared';

const RUNTIME = 'embedding-host:runtime-1';

function status(
  state: EmbeddingHostStatus['state'],
  embeddingRuntime?: Partial<NonNullable<EmbeddingHostStatus['embeddingRuntime']>>
): EmbeddingHostStatus {
  return {
    active: false,
    lastError: null,
    runtimeId: RUNTIME,
    runtimeKind: 'embedding-host',
    state,
    ...(embeddingRuntime ? { embeddingRuntime } : {}),
  } as EmbeddingHostStatus;
}

function lifecycle(current: EmbeddingHostStatus, destroyed = false) {
  const send = vi.fn();
  return {
    getHostWindow: vi.fn(() => ({ isDestroyed: () => destroyed, webContents: { send } }) as never),
    getStatus: vi.fn(() => current),
    send,
    waitForStatus:
      vi.fn<
        (
          predicate: (next: EmbeddingHostStatus) => boolean,
          timeoutMs: number
        ) => Promise<EmbeddingHostStatus>
      >(),
  };
}

test('a started host with no device is asked for one, and answers with the status carrying it (BST-2193)', async () => {
  const unresolved = status('running');
  const resolved = status('running', { hostDevice: 'wasm' });
  const host = lifecycle(unresolved);
  host.waitForStatus.mockImplementation(async (predicate, timeoutMs) => {
    expect(timeoutMs).toBe(30_000);
    // Only a resolution, or a host leaving this running runtime, ends the wait.
    expect(predicate(unresolved)).toBe(false);
    expect(predicate(resolved)).toBe(true);
    expect(predicate(status('running', { hostDeviceError: 'No WebGPU adapter.' }))).toBe(true);
    expect(predicate(status('stopping'))).toBe(true);
    expect(predicate({ ...unresolved, runtimeId: 'embedding-host:runtime-2' })).toBe(true);
    return resolved;
  });
  const request = vi.fn();
  await expect(awaitHostDevice(unresolved, host, request)).resolves.toBe(resolved);
  expect(request).toHaveBeenCalledOnce();
});

test('a host that resolved a device, or why it has none, is read without asking again', async () => {
  for (const started of [
    status('running', { hostDevice: 'webgpu' }),
    status('running', { hostDeviceError: 'No WebGPU adapter.' }),
    status('error'),
  ]) {
    const host = lifecycle(started);
    const request = vi.fn();
    await expect(awaitHostDevice(started, host, request)).resolves.toBe(started);
    expect(request).not.toHaveBeenCalled();
    expect(host.waitForStatus).not.toHaveBeenCalled();
  }
});

test('only a running, available host window is sent resolve-device', () => {
  const running = lifecycle(status('running'));
  requestHostDeviceResolution(running, true);
  expect(running.send).toHaveBeenCalledExactlyOnceWith(
    'embedding-host:command',
    expect.objectContaining({ payload: { action: 'resolve-device' }, runtimeId: RUNTIME })
  );
  for (const [host, available] of [
    [lifecycle(status('starting')), true],
    [lifecycle(status('running'), true), true],
    [lifecycle(status('running')), false],
  ] as const) {
    requestHostDeviceResolution(host, available);
    expect(host.send).not.toHaveBeenCalled();
  }
});
