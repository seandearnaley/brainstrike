import { afterEach, expect, test, vi } from 'vitest';
import { proofPersistence } from '../logging/proof-persistence.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('disabled persistence probes neither log nor observe a Promise', () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', undefined);
  vi.stubGlobal('brainstrikeWorkspacePhaseProof', undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const then = vi.fn();
  expect(
    proofPersistence('unhandled-rejection', { layer: 'renderer-error-hooks', promise: { then } })
  ).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  expect(then).not.toHaveBeenCalled();
});

test('repeated events and distinct caller promises retain separate identities without serializing reasons', () => {
  vi.stubGlobal('brainstrikeWorkspacePhaseProof', true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const first = Promise.resolve();
  const second = Promise.resolve();
  const reason = new Error('SECRET reason text');
  const event = { token: 'SECRET object field' };
  proofPersistence('unhandled-rejection', {
    layer: 'renderer-error-hooks',
    object: event,
    promise: first,
    reason,
  });
  proofPersistence('unhandled-rejection', {
    layer: 'renderer-error-hooks',
    object: event,
    promise: first,
    reason,
  });
  proofPersistence('unhandled-rejection', {
    layer: 'renderer-error-hooks',
    object: {},
    promise: second,
    reason,
  });
  const records = warn.mock.calls.map(([line]) =>
    JSON.parse(String(line).slice('[persistence-proof] '.length))
  );
  expect(records[0].promiseId).toBe(records[1].promiseId);
  expect(records[0].objectId).toBe(records[1].objectId);
  expect(records[2].promiseId).not.toBe(records[0].promiseId);
  expect(records[2].reasonId).toBe(records[0].reasonId);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
});

test('rejects arbitrary layer/phase strings before logging', () => {
  vi.stubGlobal('brainstrikeWorkspacePhaseProof', true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  Reflect.apply(proofPersistence, undefined, ['SECRET phase', { layer: 'worker-storage' }]);
  Reflect.apply(proofPersistence, undefined, ['unhandled-rejection', { layer: 'SECRET layer' }]);
  expect(warn).not.toHaveBeenCalled();
});

test('caps the realm with one explicit truncation receipt', async () => {
  vi.stubGlobal('brainstrikeWorkspacePhaseProof', true);
  const { proofPersistence: isolatedProof } = await import('../logging/proof-persistence.js');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let index = 0; index < 600; index += 1) {
    isolatedProof('worker-post', { layer: 'worker-storage' });
  }
  expect(warn).toHaveBeenCalledTimes(513);
  const records = warn.mock.calls.map(([line]) =>
    JSON.parse(String(line).slice('[persistence-proof] '.length))
  );
  expect(records.filter((event) => event.phase === 'truncated')).toHaveLength(1);
});
