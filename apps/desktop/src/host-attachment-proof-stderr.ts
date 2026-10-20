const PREFIX = '[host-attach-proof] ';
const MAX_LINE_BYTES = 2048;
// The producer admits 512 events and one fixed truncation receipt per process.
const MAX_RECORDS = 513;
const MAX_SAMPLE_BYTES = MAX_LINE_BYTES * MAX_RECORDS;
const SERVER_PHASES = new Set([
  'monitor-start',
  'loop-delay',
  'host-close-start',
  'host-record-created',
  'host-socket-accepted',
  'host-record-publish-start',
  'host-record-published',
  'host-runtime-monitor-stopped',
  'host-initialize-received',
  'host-initialize-reply-ready',
  'truncated',
]);
const NUMBERS = new Set([
  'at',
  'cpuSystemMs',
  'cpuUserMs',
  'elapsedMs',
  'eventLoopLagMaxMs',
  'eventLoopSamples',
  'eventLoopUtilization',
  'hostPid',
  'monotonicMs',
  'processPid',
  'sequence',
  'timeOrigin',
  'timerLagMs',
  'limit',
]);
const HASH = /^[0-9a-f]{24}$/u;

function safeField(key: string, field: unknown): boolean {
  if (NUMBERS.has(key)) {
    return typeof field === 'number' && Number.isFinite(field) && field >= 0;
  }
  switch (key) {
    case 'phase':
      return typeof field === 'string' && SERVER_PHASES.has(field);
    case 'scope':
      return field === 'host-runtime';
    case 'attemptId':
      return typeof field === 'string' && /^\d{1,10}:\d{1,10}$/u.test(field);
    case 'hostStartId':
    case 'endpointId':
      return typeof field === 'string' && HASH.test(field);
    case 'candidatePathIdsTruncated':
      return typeof field === 'boolean';
    default:
      return false;
  }
}

/** Observe the existing safe server family without changing the original stderr bytes. */
function isSafeRecord(line: string): boolean {
  if (!line.startsWith(PREFIX)) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['phase'] !== 'string' ||
    !SERVER_PHASES.has(record['phase']) ||
    typeof record['processPid'] !== 'number' ||
    typeof record['timeOrigin'] !== 'number'
  ) {
    return false;
  }
  if (record['phase'] === 'truncated') {
    if (record['limit'] !== 512) {
      return false;
    }
  } else if (
    typeof record['at'] !== 'number' ||
    typeof record['monotonicMs'] !== 'number' ||
    typeof record['sequence'] !== 'number' ||
    ((record['phase'] === 'monitor-start' || record['phase'] === 'loop-delay') &&
      record['scope'] !== 'host-runtime')
  ) {
    return false;
  }
  if (!Object.entries(record).every(([key, field]) => safeField(key, field))) {
    return false;
  }
  return true;
}

/** PROOF ONLY: tee original stderr with Node backpressure; parsing only observes bounded metadata. */
export function collectHostAttachmentProofStderr(
  stderr: NodeJS.ReadableStream | null,
  destination: NodeJS.WritableStream = process.stderr
): void {
  if (process.env['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] !== '1') {
    return;
  }
  const report = (value: object): void => {
    destination.write(`[host-attach-proof-collection] ${JSON.stringify(value)}\n`);
  };
  if (!stderr) {
    report({ phase: 'stderr-unavailable' });
    return;
  }
  let pending = Buffer.alloc(0);
  let oversized = false;
  let closed = false;
  let observed = 0;
  let sampledBytes = 0;
  let observationLimited = false;
  let unclassifiedLines = 0;
  let oversizedLines = 0;
  const stopObservation = (): void => {
    observationLimited = true;
    stderr.off('data', data);
  };
  const append = (segment: Buffer): void => {
    if (oversized) {
      return;
    }
    if (pending.length + segment.length > MAX_LINE_BYTES) {
      oversized = true;
      pending = Buffer.alloc(0);
      return;
    }
    pending = Buffer.concat([pending, segment]);
  };
  const settleLine = (): void => {
    if (oversized) {
      oversizedLines++;
      return;
    }
    if (!isSafeRecord(pending.toString('utf8'))) {
      unclassifiedLines++;
      return;
    }
    observed++;
    if (observed === MAX_RECORDS) {
      stopObservation();
    }
  };
  const data = (chunk: Buffer): void => {
    const sample = chunk.subarray(0, MAX_SAMPLE_BYTES - sampledBytes);
    sampledBytes += sample.length;
    let offset = 0;
    while (offset < sample.length && !observationLimited) {
      const newline = sample.indexOf(10, offset);
      const end = newline === -1 ? sample.length : newline;
      append(sample.subarray(offset, end));
      if (newline === -1) {
        break;
      }
      settleLine();
      pending = Buffer.alloc(0);
      oversized = false;
      offset = newline + 1;
    }
    if (sampledBytes === MAX_SAMPLE_BYTES) {
      stopObservation();
    }
  };
  const finish = (streamError: boolean): void => {
    if (closed) {
      return;
    }
    closed = true;
    const partialLines = pending.length > 0 || oversized ? 1 : 0;
    pending = Buffer.alloc(0);
    stderr.off('data', data);
    stderr.off('end', ended);
    stderr.off('close', ended);
    stderr.off('error', failed);
    stderr.unpipe(destination);
    report({
      observationLimited,
      observed,
      oversizedLines,
      partialLines,
      phase: 'closed',
      sampledBytes,
      streamError,
      unclassifiedLines,
    });
  };
  const ended = (): void => finish(false);
  const failed = (): void => finish(true);
  stderr.on('data', data);
  stderr.once('end', ended);
  stderr.once('close', ended);
  stderr.once('error', failed);
  // No record is re-emitted by the observer; every original byte takes this one path.
  stderr.pipe(destination, { end: false });
}
