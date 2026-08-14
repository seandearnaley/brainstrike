import { fingerprint } from './shadow-report.mjs';

export async function createBlockedRoutineResult({ baseSha, error, routineId, writeDiagnostic }) {
  const primaryReason = String(error);
  const reasons = [primaryReason];
  try {
    await writeDiagnostic(primaryReason, baseSha);
  } catch {
    reasons.push('diagnostic report write failed');
  }
  return {
    baseSha,
    fingerprint: fingerprint([routineId, baseSha, 'blocked', primaryReason, ...reasons.slice(1)]),
    reasons,
    status: 'blocked',
  };
}
