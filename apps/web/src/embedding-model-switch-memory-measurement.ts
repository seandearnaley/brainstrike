const PROBE_WORKER_URL_MARKER = 'embedding-model-switch-memory-probe.worker';

interface MemoryBreakdownAttribution {
  readonly scope: string;
  readonly url: string;
}

interface MemoryBreakdownEntry {
  readonly attribution: readonly MemoryBreakdownAttribution[];
  readonly bytes: number;
}

export interface MemoryMeasurement {
  readonly breakdown: readonly MemoryBreakdownEntry[];
  readonly bytes: number;
}

export interface ProbeWorkerMemory {
  readonly workerBreakdownCount: number;
  readonly workerBytes: number;
  readonly workerUrls: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMemoryMeasurement(value: unknown): MemoryMeasurement {
  if (!(isRecord(value) && Array.isArray(value['breakdown']))) {
    throw new Error('measureUserAgentSpecificMemory returned a malformed measurement.');
  }
  const bytes = value['bytes'];
  if (!(typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0)) {
    throw new Error('measureUserAgentSpecificMemory returned invalid total bytes.');
  }
  const breakdown: MemoryBreakdownEntry[] = value['breakdown'].map((entry: unknown) => {
    if (!(isRecord(entry) && Array.isArray(entry['attribution']))) {
      throw new Error('measureUserAgentSpecificMemory returned a malformed breakdown entry.');
    }
    const entryBytes = entry['bytes'];
    if (!(typeof entryBytes === 'number' && Number.isFinite(entryBytes) && entryBytes >= 0)) {
      throw new Error('measureUserAgentSpecificMemory returned invalid breakdown bytes.');
    }
    const attribution: MemoryBreakdownAttribution[] = entry['attribution'].map(
      (candidate: unknown) => {
        if (
          !isRecord(candidate) ||
          typeof candidate['scope'] !== 'string' ||
          typeof candidate['url'] !== 'string'
        ) {
          throw new Error('measureUserAgentSpecificMemory returned malformed attribution.');
        }
        return { scope: candidate['scope'], url: candidate['url'] };
      }
    );
    return { attribution, bytes: entryBytes };
  });
  return { breakdown, bytes };
}

export function readExclusiveProbeWorkerMemory(measurement: MemoryMeasurement): ProbeWorkerMemory {
  let workerBytes = 0;
  let workerBreakdownCount = 0;
  const workerUrls = new Set<string>();
  for (const entry of measurement.breakdown) {
    const matchingAttribution = entry.attribution.filter(
      (attribution) =>
        attribution.scope === 'DedicatedWorkerGlobalScope' &&
        attribution.url.includes(PROBE_WORKER_URL_MARKER)
    );
    if (matchingAttribution.length === 0) {
      continue;
    }
    if (matchingAttribution.length !== entry.attribution.length) {
      throw new Error(
        'BST-369 cannot isolate probe worker bytes from a mixed-attribution memory entry.'
      );
    }
    workerBreakdownCount += 1;
    workerBytes += entry.bytes;
    for (const attribution of matchingAttribution) {
      workerUrls.add(attribution.url);
    }
  }
  return {
    workerBreakdownCount,
    workerBytes,
    workerUrls: [...workerUrls].sort(),
  };
}
