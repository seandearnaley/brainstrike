import { createHash } from 'node:crypto';

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) {
    return value;
  }
  throw new Error('fingerprint input must contain only JSON data');
}

function stdoutOf(result) {
  return typeof result === 'string' ? result : result.stdout;
}

export function createActivePrFingerprint({ candidate, routineId }) {
  if (typeof routineId !== 'string' || routineId.length === 0) {
    throw new Error('routineId is required');
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ candidate, routineId })))
    .digest('hex');
}

export function fingerprintMarker(fingerprint) {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('invalid routine fingerprint');
  }
  return `<!-- brainstrike-routine-fingerprint:${fingerprint} -->`;
}

export async function findActivePrByFingerprint({ fingerprint, repository, runGh }) {
  const marker = fingerprintMarker(fingerprint);
  let parsed;
  try {
    const result = await runGh({
      args: [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,url,headRefName,body',
      ],
    });
    parsed = JSON.parse(stdoutOf(result));
  } catch (error) {
    throw new Error('GitHub PR state is unreadable; refusing scheduled maintenance', {
      cause: error,
    });
  }
  if (
    !(
      Array.isArray(parsed) &&
      parsed.every(
        (pr) =>
          pr !== null &&
          typeof pr === 'object' &&
          typeof pr.body === 'string' &&
          typeof pr.headRefName === 'string' &&
          Number.isSafeInteger(pr.number) &&
          typeof pr.url === 'string'
      )
    )
  ) {
    throw new Error('GitHub PR state is unreadable; refusing scheduled maintenance');
  }
  return (
    parsed.find((pr) => pr.body.includes(marker) || pr.headRefName.includes(fingerprint)) ?? null
  );
}
