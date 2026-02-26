/* Normalizes tool progress payloads coming from diverse sources (SSE, stdio).
 * Input examples handled:
 * - { step: 'starting' }
 * - { percent: 32 }
 * - { progress: 0.42 }
 * - { done: 21, total: 100 }
 * - { message: 'embedding chunk 5/100' }
 */

export interface NormalizedProgress {
  note?: string;
  percent?: number; // 0..100
  raw?: unknown;
  step?: string;
}

export function normalizeProgressPayload(input: unknown): NormalizedProgress {
  const out: NormalizedProgress = { raw: input };
  if (!input || typeof input !== 'object') {
    return out;
  }
  const obj = input as Record<string, unknown>;

  // Step/message mapping
  const step = (obj['step'] ?? obj['phase'] ?? obj['stage']) as unknown;
  if (typeof step === 'string' && step.trim()) {
    out.step = step.trim();
  }
  const msg = (obj['message'] ?? obj['note'] ?? obj['status']) as unknown;
  if (!out.step && typeof msg === 'string' && msg.trim()) {
    out.note = msg.trim();
  }

  // Percent mapping
  const percent = (obj['percent'] ?? obj['pct']) as unknown;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    out.percent = clamp01To100(percent);
  }

  // Progress in [0,1]
  const progress = obj['progress'] as unknown;
  if (out.percent === undefined && typeof progress === 'number' && Number.isFinite(progress)) {
    out.percent = clamp01To100(progress * 100);
  }

  // done/total
  const done = obj['done'] as unknown;
  const total = obj['total'] as unknown;
  if (
    out.percent === undefined &&
    typeof done === 'number' &&
    Number.isFinite(done) &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0
  ) {
    out.percent = clamp01To100((done / total) * 100);
    if (!out.note) {
      out.note = `${Math.floor(done)}/${Math.floor(total)}`;
    }
  }

  return out;
}

function clamp01To100(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return Math.round(n * 10) / 10; // 1 decimal
}
