import { performance } from 'node:perf_hooks';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
});

test.each(['liveLease-before', 'readHostRecord-before'] as const)(
  'publication stages do not emit per poll and retain elapsed time for %s',
  async (pendingStage) => {
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
    const { startHostAttachmentDiagnostics } = await import('../src/attachment-diagnostics.js');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const probe = startHostAttachmentDiagnostics('record-publication', undefined, {
      budget: 'self-started',
      timeoutMs: 1500,
    });
    expect(probe).toBeDefined();
    for (let index = 0; index < 1000; index += 1) {
      probe?.publicationStage('liveLease-before');
      probe?.publicationStage('liveLease-after', 'matched');
      probe?.publicationStage('readHostRecord-before');
      probe?.publicationStage('readHostRecord-after', 'missing');
    }
    expect(write).toHaveBeenCalledTimes(1);
    now.mockReturnValue(200);
    probe?.publicationStage(pendingStage);
    Reflect.apply(probe?.publicationStage ?? (() => {}), undefined, [
      'SECRET stage',
      'SECRET outcome',
    ]);
    now.mockReturnValue(235);
    probe?.phase('record-publication-timeout');
    probe?.finish('record-publication-settled');
    const events = write.mock.calls.map(([line]) =>
      JSON.parse(String(line).slice('[host-attach-proof] '.length))
    );
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      budget: 'self-started',
      lastStage: pendingStage,
      stageElapsedMs: 35,
      timeoutMs: 1500,
    });
    expect(events[1]).not.toHaveProperty('lastOutcome');
    expect(events[2]).toMatchObject({ lastStage: pendingStage, stageElapsedMs: 35 });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  }
);

test('projects bounded discovery identities and rejects arbitrary scope/phase strings', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  const { startHostAttachmentDiagnostics, writeHostAttachmentDiagnostic } = await import(
    '../src/attachment-diagnostics.js'
  );
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(
    Reflect.apply(startHostAttachmentDiagnostics, undefined, ['SECRET scope'])
  ).toBeUndefined();
  Reflect.apply(writeHostAttachmentDiagnostic, undefined, ['SECRET phase']);
  expect(write).not.toHaveBeenCalled();
  const record = {
    endpoint: '/SECRET endpoint',
    pid: 123,
    start: 'SECRET OS start',
    token: 'SECRET token',
  };
  writeHostAttachmentDiagnostic('reader-record-candidates', record, {
    candidateCount: 24,
    candidatePathIds: Array.from({ length: 24 }, (_, index) =>
      index.toString(16).padStart(24, '0')
    ),
    selectedPathId: '/SECRET path',
  });
  const payload = JSON.parse(String(write.mock.calls[0]?.[0]).slice('[host-attach-proof] '.length));
  expect(payload).toMatchObject({
    candidateCount: 24,
    candidatePathIdsTruncated: true,
    hostPid: 123,
  });
  expect(payload.candidatePathIds).toHaveLength(16);
  expect(payload).not.toHaveProperty('selectedPathId');
  expect(JSON.stringify(write.mock.calls)).not.toContain('SECRET');
});

test('emits one truncation receipt and still disposes its monitor after the cap', async () => {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
  vi.useFakeTimers();
  const { startHostAttachmentDiagnostics, writeHostAttachmentDiagnostic } = await import(
    '../src/attachment-diagnostics.js'
  );
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const probe = startHostAttachmentDiagnostics('host-runtime');
  expect(probe).toBeDefined();
  try {
    for (let index = 0; index < 600; index += 1) {
      writeHostAttachmentDiagnostic('socket-connect');
    }
    expect(write).toHaveBeenCalledTimes(513);
    const records = write.mock.calls.map(([line]) =>
      JSON.parse(String(line).slice('[host-attach-proof] '.length))
    );
    expect(records.filter((event) => event.phase === 'truncated')).toHaveLength(1);
    probe?.finish('host-runtime-monitor-stopped');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(513);
  } finally {
    probe?.finish('host-runtime-monitor-stopped');
  }
});
