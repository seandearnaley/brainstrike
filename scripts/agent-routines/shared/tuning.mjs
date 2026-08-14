const CONFIG_KEYS = new Set([
  'confidenceFloor',
  'dedupeWindowRuns',
  'maxFindings',
  'recentWindowHours',
  'revision',
]);
const BOUNDS = Object.freeze({
  confidenceFloor: Object.freeze({ max: 0.99, min: 0.5 }),
  dedupeWindowRuns: Object.freeze({ max: 20, min: 1 }),
  maxFindings: Object.freeze({ max: 100, min: 1 }),
  recentWindowHours: Object.freeze({ max: 168, min: 24 }),
});

function assertRate(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid tuning ${name}`);
  }
}

function validate({ current, evaluation, targets }) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('invalid tuning state');
  }
  for (const key of Object.keys(current)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`unmodelled tuning key: ${key}`);
    }
  }
  if (
    Object.keys(current).length !== CONFIG_KEYS.size ||
    !Number.isSafeInteger(current.revision) ||
    current.revision < 0 ||
    !Number.isSafeInteger(current.dedupeWindowRuns) ||
    !Number.isSafeInteger(current.maxFindings) ||
    !Number.isSafeInteger(current.recentWindowHours)
  ) {
    throw new Error('invalid tuning state');
  }
  assertRate(current.confidenceFloor, 'confidence floor');
  for (const [field, bounds] of Object.entries(BOUNDS)) {
    if (current[field] < bounds.min || current[field] > bounds.max) {
      throw new Error(`tuning state outside bounds: ${field}`);
    }
  }
  if (
    !evaluation ||
    typeof evaluation !== 'object' ||
    !Number.isSafeInteger(evaluation.criticalFalsePositives) ||
    evaluation.criticalFalsePositives < 0 ||
    !Number.isSafeInteger(evaluation.unsafeFindings) ||
    evaluation.unsafeFindings < 0 ||
    !Number.isSafeInteger(evaluation.reportCount) ||
    evaluation.reportCount < 0 ||
    !Number.isSafeInteger(evaluation.sampleCount) ||
    evaluation.sampleCount < 0 ||
    typeof evaluation.routineId !== 'string' ||
    evaluation.routineId.length === 0
  ) {
    throw new Error('invalid tuning evaluation');
  }
  assertRate(evaluation.duplicateRate, 'duplicate rate');
  assertRate(evaluation.noiseRate, 'noise rate');
  assertRate(evaluation.precision, 'precision');
  if (!targets || typeof targets !== 'object') {
    throw new Error('invalid tuning targets');
  }
  assertRate(targets.maxDuplicateRate, 'duplicate target');
  assertRate(targets.maxNoiseRate, 'noise target');
}

function roundedRate(value) {
  return Math.round(value * 100) / 100;
}

export function tightenRoutineTuning({ current, evaluation, targets }) {
  validate({ current, evaluation, targets });
  const unsafe = evaluation.criticalFalsePositives > 0 || evaluation.unsafeFindings > 0;
  const noisy = evaluation.noiseRate > targets.maxNoiseRate;
  const duplicateHeavy = evaluation.duplicateRate > targets.maxDuplicateRate;
  const proposed = { ...current };
  const reasons = new Map();

  if (unsafe || noisy) {
    proposed.confidenceFloor = Math.min(
      BOUNDS.confidenceFloor.max,
      roundedRate(current.confidenceFloor + (unsafe ? 0.05 : 0.02))
    );
    reasons.set('confidenceFloor', unsafe ? 'unsafe finding observed' : 'noise target exceeded');
    proposed.maxFindings = Math.max(
      BOUNDS.maxFindings.min,
      Math.floor(current.maxFindings * (unsafe ? 0.5 : 0.8))
    );
    reasons.set('maxFindings', unsafe ? 'unsafe finding observed' : 'noise target exceeded');
    proposed.recentWindowHours = Math.max(
      BOUNDS.recentWindowHours.min,
      current.recentWindowHours - (unsafe ? 48 : 24)
    );
    reasons.set('recentWindowHours', unsafe ? 'unsafe finding observed' : 'noise target exceeded');
  }
  if (duplicateHeavy) {
    proposed.dedupeWindowRuns = Math.min(BOUNDS.dedupeWindowRuns.max, current.dedupeWindowRuns + 1);
    reasons.set('dedupeWindowRuns', 'duplicate target exceeded');
  }

  const changes = [];
  for (const field of ['confidenceFloor', 'dedupeWindowRuns', 'maxFindings', 'recentWindowHours']) {
    if (proposed[field] !== current[field]) {
      changes.push({
        field,
        from: current[field],
        reason: reasons.get(field),
        to: proposed[field],
      });
    }
  }
  if (changes.length > 0) {
    proposed.revision = current.revision + 1;
  }
  return Object.freeze({
    changes: Object.freeze(changes.map(Object.freeze)),
    next: Object.freeze(proposed),
    requiresManualIntervention: unsafe && changes.length === 0,
    routineId: evaluation.routineId,
  });
}
