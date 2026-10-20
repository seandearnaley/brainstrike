import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectHostAttachmentProofStderr } from '../../host-attachment-proof-stderr';

const prefix = '[host-attach-proof] ';
const monitor = {
  at: 123,
  attemptId: '123:1',
  cpuSystemMs: 0,
  cpuUserMs: 1,
  elapsedMs: 0.1,
  eventLoopLagMaxMs: 0,
  eventLoopSamples: 0,
  eventLoopUtilization: 0.2,
  monotonicMs: 1,
  phase: 'monitor-start',
  processPid: 123,
  scope: 'host-runtime',
  sequence: 2,
  timeOrigin: 456,
  timerLagMs: 0,
};
const line = (record: unknown): string => `${prefix}${JSON.stringify(record)}\n`;
function capture(flag: string | undefined = '1') {
  vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', flag);
  const stderr = new PassThrough();
  const destination = new PassThrough();
  const chunks: Buffer[] = [];
  destination.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  collectHostAttachmentProofStderr(stderr, destination);
  return { bytes: () => Buffer.concat(chunks), destination, stderr };
}
async function finish(stderr: PassThrough): Promise<void> {
  await new Promise<void>((resolve) => {
    stderr.once('end', resolve);
    stderr.end();
  });
}
function summary(bytes: Buffer, originalLength: number) {
  const tail = bytes.subarray(originalLength).toString('utf8').trim();
  expect(tail.startsWith('[host-attach-proof-collection] ')).toBe(true);
  return JSON.parse(tail.slice('[host-attach-proof-collection] '.length));
}
afterEach(() => vi.unstubAllEnvs());

describe('proof-only utility stderr tee', () => {
  it('retains ordinary/fatal bytes and an existing probe exactly once across split chunks', async () => {
    const { bytes, destination, stderr } = capture();
    const input = Buffer.concat([
      Buffer.from('ordinary-fatal-sentinel\n'),
      Buffer.from(line(monitor)),
      Buffer.from([0, 255, 195, 169, 13, 10]),
      Buffer.from('unterminated-fatal-sentinel'),
    ]);
    for (const byte of input) {
      stderr.write(Buffer.from([byte]));
    }
    expect(bytes().equals(input)).toBe(true);
    await finish(stderr);
    expect(bytes().subarray(0, input.length).equals(input)).toBe(true);
    expect(summary(bytes(), input.length)).toMatchObject({
      observed: 1,
      partialLines: 1,
      phase: 'closed',
      streamError: false,
    });
    expect(destination.writableEnded).toBe(false);
    expect(bytes().toString('utf8').split(prefix)).toHaveLength(2);
    destination.destroy();
  });

  it('preserves unknown, malformed and oversized bytes while observing only safe probes', async () => {
    const { bytes, destination, stderr } = capture();
    const input = Buffer.from(
      'ordinary-error-sentinel\n' +
        line({ ...monitor, unexpected: 'opaque-sentinel' }) +
        `${prefix}{invalid-sentinel\n` +
        'x'.repeat(10_000) +
        '\n' +
        line(monitor)
    );
    for (let offset = 0; offset < input.length; offset += 31) {
      stderr.write(input.subarray(offset, offset + 31));
    }
    expect(bytes().equals(input)).toBe(true);
    await finish(stderr);
    expect(summary(bytes(), input.length)).toMatchObject({
      observed: 1,
      oversizedLines: 1,
      partialLines: 0,
      unclassifiedLines: 3,
    });
    destination.destroy();
  });

  it('caps record observation without dropping subsequent probes or fatal bytes', async () => {
    const { bytes, destination, stderr } = capture();
    const truncated = { limit: 512, phase: 'truncated', processPid: 123, timeOrigin: 456 };
    const input = Buffer.from(
      `${line(monitor).repeat(512)}${line(truncated)}${line(monitor)}late-fatal-sentinel\n`
    );
    stderr.write(input);
    expect(bytes().equals(input)).toBe(true);
    await finish(stderr);
    expect(summary(bytes(), input.length)).toMatchObject({
      observationLimited: true,
      observed: 513,
    });
    destination.destroy();
  });

  it('caps bytes inspected while forwarding every oversized byte and following error unchanged', async () => {
    const { bytes, destination, stderr } = capture();
    const input = Buffer.from(`${'x'.repeat(2048 * 513 + 5000)}\nlate-fatal-sentinel\n`);
    stderr.write(input);
    expect(bytes().equals(input)).toBe(true);
    await finish(stderr);
    expect(summary(bytes(), input.length)).toMatchObject({
      observationLimited: true,
      sampledBytes: 2048 * 513,
    });
    destination.destroy();
  });

  it.each(['end', 'close', 'error'] as const)(
    'cleans up once on %s without ending the destination',
    async (event) => {
      const { bytes, destination, stderr } = capture();
      const input = Buffer.from(`${line(monitor)}partial-fatal-sentinel`);
      stderr.write(input);
      if (event === 'end') {
        await finish(stderr);
      } else if (event === 'error') {
        stderr.emit('error', new Error('synthetic-stream-error'));
      } else {
        stderr.emit('close');
      }
      expect(bytes().subarray(0, input.length).equals(input)).toBe(true);
      expect(summary(bytes(), input.length)).toMatchObject({
        partialLines: 1,
        phase: 'closed',
        streamError: event === 'error',
      });
      expect(destination.writableEnded).toBe(false);
      expect(stderr.listenerCount('data')).toBe(0);
      expect(stderr.listenerCount('end')).toBe(0);
      expect(stderr.listenerCount('close')).toBe(0);
      expect(stderr.listenerCount('error')).toBe(0);
      const length = bytes().length;
      stderr.emit('close');
      expect(bytes().length).toBe(length);
      stderr.destroy();
      destination.destroy();
    }
  );

  it('uses pipe backpressure and resumes forwarding after destination drain', async () => {
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    let releaseFirst: (() => void) | undefined;
    const destination = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (chunks.length === 1) {
          releaseFirst = () => callback();
          return;
        }
        callback();
      },
    });
    collectHostAttachmentProofStderr(stderr, destination);
    stderr.write('first-sentinel\n');
    stderr.write('second-sentinel\n');
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    expect(stderr.isPaused()).toBe(true);
    expect(chunks.length).toBe(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(chunks.length).toBe(2));
    const original = Buffer.from('first-sentinel\nsecond-sentinel\n');
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
    await finish(stderr);
    expect(destination.writableEnded).toBe(false);
    destination.destroy();
  });

  it.each([undefined, '', '0'])('does not pipe, listen or write when disabled (%s)', (flag) => {
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', flag);
    const stderr = new PassThrough();
    const destination = new PassThrough();
    const write = vi.spyOn(destination, 'write');
    collectHostAttachmentProofStderr(stderr, destination);
    stderr.write('disabled-sentinel\n');
    expect(stderr.listenerCount('data')).toBe(0);
    expect(stderr.listenerCount('error')).toBe(0);
    expect(write).not.toHaveBeenCalled();
    stderr.destroy();
    destination.destroy();
  });

  it('reports an unavailable proof stream using fixed metadata only', () => {
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', '1');
    const destination = new PassThrough();
    const chunks: Buffer[] = [];
    destination.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    collectHostAttachmentProofStderr(null, destination);
    expect(Buffer.concat(chunks).toString('utf8')).toBe(
      '[host-attach-proof-collection] {"phase":"stderr-unavailable"}\n'
    );
    destination.destroy();
  });
});
