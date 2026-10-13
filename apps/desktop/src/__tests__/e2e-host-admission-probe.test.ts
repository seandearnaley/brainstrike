// @vitest-environment node
import {
  type HostLogRow,
  HostLogRowSchema,
  parseHostParams,
} from '@brainstrike/agent-host/protocol';
import { expect, it, vi } from 'vitest';
import { createHostAdmissionProbe } from '../e2e-host-admission-probe';
import recorded from './fixtures/foreground-host-admission.json';

const params = parseHostParams('run/start', recorded.params);
const finished = HostLogRowSchema.parse(recorded.finished);
function fixture() {
  let now = 0;
  const events = new Set<(row: HostLogRow) => void>();
  const closed = Promise.withResolvers<void>();
  const physicalClose = Promise.withResolvers<void>();
  const request = vi.fn<(input: typeof params) => Promise<{ runId: string }>>();
  const observer = {
    close: vi.fn(() => physicalClose.promise),
    closed: closed.promise,
    onEvent: (listener: (row: HostLogRow) => void) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    subscribe: vi.fn(async () => undefined),
  };
  return {
    closed,
    create: () =>
      createHostAdmissionProbe({ now: () => now, observer, request, threadId: params.threadId }),
    emit: (row: HostLogRow) => {
      for (const listener of events) {
        listener(row);
      }
    },
    events,
    observer,
    physicalClose,
    request,
    setNow: (value: number) => {
      now = value;
    },
  };
}
it('subscribes before public dispatch and excludes terminal settlement from admission timing', async () => {
  const f = fixture();
  const probe = await f.create();
  f.request.mockImplementation(async (input) => {
    expect(f.observer.subscribe).toHaveBeenCalledWith(params.threadId);
    expect(input).toEqual(params);
    f.setNow(23);
    return { runId: recorded.finished.event.runId };
  });
  const result = probe.run(params);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  f.setNow(900);
  f.emit(finished);
  await expect(result).resolves.toBe(23);
  f.physicalClose.resolve();
  await probe.close();
  expect(f.events.size).toBe(0);
});
it('retains a terminal event received before run/start acknowledgement', async () => {
  const f = fixture();
  const probe = await f.create();
  f.request.mockImplementation(async () => {
    f.emit(finished);
    f.setNow(7);
    return { runId: recorded.finished.event.runId };
  });
  await expect(probe.run(params)).resolves.toBe(7);
  f.physicalClose.resolve();
  await probe.close();
});
it('propagates public admission rejection and physically joins observer close', async () => {
  const f = fixture();
  const probe = await f.create();
  const refusal = new Error('recorded admission refusal');
  f.request.mockRejectedValue(refusal);
  await expect(probe.run(params)).rejects.toBe(refusal);
  const closing = probe.close();
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.physicalClose.resolve();
  await closing;
});
it('invalidates the sample if the observer closes before the terminal receipt', async () => {
  const f = fixture();
  const probe = await f.create();
  f.request.mockResolvedValue({ runId: recorded.finished.event.runId });
  const result = probe.run(params);
  const failure = expect(result).rejects.toThrow();
  f.closed.resolve();
  await failure;
  f.physicalClose.resolve();
  await probe.close();
});
it('retains an independent physical close failure', async () => {
  const f = fixture();
  const probe = await f.create();
  const failure = new Error('observer retirement failed');
  const closing = probe.close();
  const rejected = expect(closing).rejects.toBe(failure);
  f.physicalClose.reject(failure);
  await rejected;
});

it('preserves independent admission and physical retirement failures during close', async () => {
  const f = fixture();
  const probe = await f.create();
  const admission = Promise.withResolvers<{ runId: string }>();
  f.request.mockReturnValue(admission.promise);
  const running = probe.run(params);
  void running.catch(() => undefined);
  const closing = probe.close();
  const admissionFailure = new Error('admission transport failed');
  const closeFailure = new Error('physical retirement failed');
  const rejected = expect(closing).rejects.toMatchObject({
    errors: [closeFailure, admissionFailure],
  });
  admission.reject(admissionFailure);
  f.physicalClose.reject(closeFailure);
  await rejected;
});
it('preserves subscription failure and failed physical cleanup', async () => {
  const f = fixture();
  const subscribeFailure = new Error('subscription refused');
  const closeFailure = new Error('physical retirement failed');
  f.observer.subscribe.mockRejectedValue(subscribeFailure);
  const creating = f.create();
  const rejected = expect(creating).rejects.toMatchObject({
    errors: [subscribeFailure, closeFailure],
  });
  f.physicalClose.reject(closeFailure);
  await rejected;
  expect(f.events.size).toBe(0);
});
it('rejects a committed non-successful terminal outcome instead of recording latency', async () => {
  const f = fixture();
  const probe = await f.create();
  f.request.mockResolvedValue({ runId: recorded.finished.event.runId });
  const result = probe.run(params);
  const rejected = expect(result).rejects.toThrow('failed');
  const failed = HostLogRowSchema.parse({
    ...recorded.finished,
    event: { ...recorded.finished.event, outcome: 'failed' },
  });
  f.emit(failed);
  await rejected;
  f.physicalClose.resolve();
  await probe.close();
});
