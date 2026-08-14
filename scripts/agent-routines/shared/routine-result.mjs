const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const STATUSES = new Set(['blocked', 'no-change', 'proposed-pr', 'report']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidRoutineResult(result) {
  if (
    result === null ||
    typeof result !== 'object' ||
    !STATUSES.has(result.status) ||
    !SHA_PATTERN.test(result.baseSha) ||
    !isNonEmptyString(result.fingerprint)
  ) {
    return false;
  }
  if (result.status === 'blocked') {
    return Array.isArray(result.reasons) && result.reasons.every(isNonEmptyString);
  }
  if (result.status === 'report') {
    return isNonEmptyString(result.summary);
  }
  if (result.status === 'proposed-pr') {
    return (
      SHA_PATTERN.test(result.headSha) &&
      isNonEmptyString(result.prUrl) &&
      URL.canParse(result.prUrl)
    );
  }
  return true;
}

export function createRoutineResultWriter(writeLine = console.log) {
  let written = false;
  return Object.freeze({
    assertWritten() {
      if (!written) {
        throw new Error('terminal RoutineResult was not written');
      }
    },
    write(result) {
      if (written) {
        throw new Error('terminal RoutineResult was already written');
      }
      if (!isValidRoutineResult(result)) {
        throw new Error('invalid RoutineResult');
      }
      written = true;
      writeLine(JSON.stringify(result));
    },
    get written() {
      return written;
    },
  });
}
