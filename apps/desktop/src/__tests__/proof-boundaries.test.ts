// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { proofAgentStartup } from '../diagnostics/proof-agent-startup';
import {
  proofCanonicalChannel,
  proofCanonicalSender,
} from '../diagnostics/proof-canonical-channel';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('keeps disabled proof senders identical and emits no startup or canonical records', () => {
  vi.stubEnv('BRAINSTRIKE_PROOF_CANONICAL', '0');
  vi.stubEnv('BRAINSTRIKE_PROOF_STARTUP', '0');
  const write = vi.spyOn(process.stderr, 'write');
  const send = vi.fn();
  expect(proofCanonicalSender('parent', send)).toBe(send);
  proofCanonicalChannel('parent', 'receive', {
    kind: 'call',
    owner: 'private-owner',
    payload: 'secret',
  });
  proofAgentStartup('entry-body');
  expect(write).not.toHaveBeenCalled();
});

it('redacts even unrecognized operation/kind values and preserves the exact failed send', () => {
  vi.stubEnv('BRAINSTRIKE_PROOF_CANONICAL', '1');
  const write = vi.spyOn(process.stderr, 'write');
  const failure = new Error('private-error');
  const send = proofCanonicalSender('parent', () => {
    throw failure;
  });
  expect(() =>
    send({
      id: 1,
      kind: 'call',
      op: 'private-operation',
      owner: 'private-owner',
      payload: 'private-payload',
      requestId: 'private-request',
    })
  ).toThrow(failure);
  proofCanonicalChannel('child', 'receive', {
    error: { message: 'secret-error' },
    kind: { private: 'secret-kind' },
    owner: 'private-owner',
  });
  const serialized = write.mock.calls.map(([chunk]) => String(chunk)).join('');
  expect(serialized).toContain('"phase":"send-failed"');
  expect(serialized).not.toContain('"phase":"sent"');
  expect(serialized).toContain('"op":"unknown"');
  expect(serialized).toContain('"kind":"invalid"');
  for (const secret of ['private-', 'secret-kind', 'secret-error']) {
    expect(serialized).not.toContain(secret);
  }
});

it('emits an opt-in startup mark without application input or extra async work', () => {
  vi.stubEnv('BRAINSTRIKE_PROOF_STARTUP', '1');
  const write = vi.spyOn(process.stderr, 'write');
  proofAgentStartup('control-evaluation-start');
  expect(write).toHaveBeenCalledOnce();
  const record = JSON.parse(
    String(write.mock.calls[0]?.[0]).slice('[agent-startup-proof] '.length)
  );
  expect(record).toMatchObject({
    phase: 'control-evaluation-start',
    pid: process.pid,
    ppid: process.ppid,
  });
  expect(record.monotonicMs).toBeGreaterThan(0);
});
