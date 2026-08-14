import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LABELS = new Set(['correct-actionable', 'duplicate-noise', 'ambiguous', 'unsafe']);

export function fingerprint(parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function canonicalJson(value, ancestors = new Set()) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical JSON rejects non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`canonical JSON rejects ${typeof value} values`);
  }
  if (ancestors.has(value)) {
    throw new Error('canonical JSON rejects cyclic values');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some((key) => typeof key === 'symbol') ||
        ownKeys.length !== value.length + 1 ||
        ownKeys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(?:0|[1-9]\d*)$/u.test(key) ||
              Number(key) >= value.length)
        )
      ) {
        throw new Error('canonical JSON rejects sparse arrays and non-index array properties');
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('canonical JSON rejects non-plain objects');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new Error('canonical JSON rejects symbol-keyed properties');
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'))) {
        throw new Error('canonical JSON rejects non-data properties');
      }
    }
    return `{${keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalReportId(report) {
  return fingerprint([canonicalJson(report)]);
}

export function evaluateLabelledFindings(routineId, findings, labels) {
  if (!(Array.isArray(findings) && Array.isArray(labels))) {
    throw new Error('calibration data is unreadable');
  }
  const byFingerprint = new Map();
  for (const entry of labels) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.fingerprint !== 'string' ||
      !LABELS.has(entry.label) ||
      byFingerprint.has(entry.fingerprint)
    ) {
      throw new Error('external labels are malformed or duplicated');
    }
    byFingerprint.set(entry.fingerprint, entry.label);
  }
  const counts = { ambiguous: 0, correct: 0, noise: 0, unsafe: 0 };
  for (const finding of findings) {
    const label = byFingerprint.get(finding.fingerprint);
    if (!label) {
      throw new Error(`missing external label: ${finding.fingerprint}`);
    }
    if (label === 'correct-actionable') {
      counts.correct += 1;
    } else if (label === 'duplicate-noise') {
      counts.noise += 1;
    } else if (label === 'ambiguous') {
      counts.ambiguous += 1;
    } else {
      counts.unsafe += 1;
    }
  }
  if (byFingerprint.size !== findings.length) {
    throw new Error('external labels contain findings absent from the evaluated report');
  }
  const judged = counts.correct + counts.noise + counts.unsafe;
  const total = findings.length;
  return {
    criticalFalsePositives: counts.unsafe,
    duplicateRate: total === 0 ? 0 : counts.noise / total,
    noiseRate: total === 0 ? 0 : (counts.noise + counts.ambiguous) / total,
    precision: judged === 0 ? 0 : counts.correct / judged,
    reportCount: total === 0 ? 0 : 1,
    routineId,
    sampleCount: total,
    unsafeFindings: counts.unsafe,
  };
}

export async function writeJsonAtomic(file, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > 10 * 1024 * 1024) {
    throw new Error('report exceeds 10 MiB');
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, file);
}
