const FORBIDDEN_EXECUTABLES = new Set(['rm', 'rmdir', 'shred', 'vercel']);

function globMatches(pattern, value) {
  const expression = pattern
    .replaceAll(/[.+?^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${expression}$`, 'u').test(value);
}

function hasArgument(args, values) {
  return args.some(
    (arg) => values.has(arg) || [...values].some((value) => arg.startsWith(`${value}=`))
  );
}

function assertCommandIsSafe(command) {
  const executable = command.file.split(/[\\/]/u).at(-1).toLowerCase();
  const args = command.args;
  if (FORBIDDEN_EXECUTABLES.has(executable)) {
    throw new Error(`forbidden executable: ${executable}`);
  }
  if (executable === 'git') {
    const pushes = args.includes('push');
    const targetsMain = args.some(
      (arg) => arg === 'main' || arg === 'refs/heads/main' || /:(?:refs\/heads\/)?main$/u.test(arg)
    );
    if (
      (pushes &&
        (hasArgument(args, new Set(['--force', '--force-with-lease', '-f'])) || targetsMain)) ||
      (args.includes('reset') && hasArgument(args, new Set(['--hard']))) ||
      args.includes('clean')
    ) {
      throw new Error('forbidden git command');
    }
  }
  const ghPrIndex = executable === 'gh' ? args.indexOf('pr') : -1;
  if (ghPrIndex >= 0 && args[ghPrIndex + 1] === 'merge') {
    throw new Error('forbidden auto-merge command');
  }
  if (args.some((arg) => arg === 'deploy' || arg === 'deploy:preview' || arg === '--prod')) {
    throw new Error('forbidden deploy command');
  }
}

function commandMatches(rule, command) {
  return (
    rule.file === command.file &&
    rule.argsPrefix.every((argument, index) => command.args[index] === argument)
  );
}

export function createPromotionPolicy({
  maxDuplicateRate,
  maxNoiseRate,
  minimumPrecisionByRoutine,
  minimumSamples,
}) {
  const rates = [maxDuplicateRate, maxNoiseRate, ...Object.values(minimumPrecisionByRoutine)];
  if (
    !Number.isSafeInteger(minimumSamples) ||
    minimumSamples <= 0 ||
    rates.some((rate) => !Number.isFinite(rate) || rate < 0 || rate > 1) ||
    Object.keys(minimumPrecisionByRoutine).length === 0
  ) {
    throw new Error('invalid promotion-readiness policy');
  }
  return Object.freeze({
    maxDuplicateRate,
    maxNoiseRate,
    minimumPrecisionByRoutine: Object.freeze({ ...minimumPrecisionByRoutine }),
    minimumSamples,
  });
}

function isValidEvaluationSummary(summary) {
  return (
    summary !== null &&
    typeof summary === 'object' &&
    typeof summary.routineId === 'string' &&
    Number.isSafeInteger(summary.sampleCount) &&
    summary.sampleCount >= 0 &&
    Number.isSafeInteger(summary.criticalFalsePositives) &&
    summary.criticalFalsePositives >= 0 &&
    Number.isSafeInteger(summary.unsafeFindings) &&
    summary.unsafeFindings >= 0 &&
    [summary.duplicateRate, summary.noiseRate, summary.precision].every(
      (rate) => Number.isFinite(rate) && rate >= 0 && rate <= 1
    )
  );
}

export function assertPromotionReady(policy, summary) {
  if (!isValidEvaluationSummary(summary)) {
    throw new Error('calibration data is unreadable; propose-pr mode is forbidden');
  }
  const minimumPrecision = policy.minimumPrecisionByRoutine[summary.routineId];
  if (minimumPrecision === undefined) {
    throw new Error(`no precision threshold configured for routine: ${summary.routineId}`);
  }
  if (
    summary.sampleCount < policy.minimumSamples ||
    summary.criticalFalsePositives !== 0 ||
    summary.unsafeFindings !== 0 ||
    summary.duplicateRate > policy.maxDuplicateRate ||
    summary.noiseRate > policy.maxNoiseRate ||
    summary.precision < minimumPrecision
  ) {
    throw new Error(`routine is not promotion-ready: ${summary.routineId}`);
  }
}

export function createRoutinePolicy({ allowedCommands, allowedFiles, maxChangedLines }) {
  if (!Number.isSafeInteger(maxChangedLines) || maxChangedLines < 0) {
    throw new Error('maxChangedLines must be a non-negative safe integer');
  }
  return Object.freeze({
    allowedCommands: Object.freeze(
      allowedCommands.map((command) =>
        Object.freeze({ argsPrefix: Object.freeze([...command.argsPrefix]), file: command.file })
      )
    ),
    allowedFiles: Object.freeze([...allowedFiles]),
    maxChangedLines,
  });
}

export function assertPolicyAllows(policy, request) {
  if (
    request === null ||
    typeof request !== 'object' ||
    typeof request.branch !== 'string' ||
    !Array.isArray(request.changedFiles) ||
    !request.changedFiles.every(
      (file) =>
        typeof file === 'string' &&
        file.length > 0 &&
        !file.startsWith('/') &&
        !file.split('/').includes('..')
    ) ||
    !Number.isSafeInteger(request.insertedLines) ||
    request.insertedLines < 0 ||
    !Number.isSafeInteger(request.deletedLines) ||
    request.deletedLines < 0 ||
    !Number.isSafeInteger(request.proposedPrCount) ||
    request.proposedPrCount < 0 ||
    request.command === null ||
    typeof request.command !== 'object' ||
    typeof request.command.file !== 'string' ||
    request.command.file.length === 0 ||
    !Array.isArray(request.command.args) ||
    !request.command.args.every((argument) => typeof argument === 'string')
  ) {
    throw new Error('invalid mutation request');
  }
  if (request.branch === 'main' || request.branch === 'refs/heads/main') {
    throw new Error('forbidden target branch: main');
  }
  if (request.proposedPrCount >= 1) {
    throw new Error('policy permits only one PR per run');
  }
  for (const file of request.changedFiles) {
    if (!policy.allowedFiles.some((pattern) => globMatches(pattern, file))) {
      throw new Error(`changed file is outside the routine allowlist: ${file}`);
    }
  }
  if (request.insertedLines + request.deletedLines > policy.maxChangedLines) {
    throw new Error('routine diff budget exceeded');
  }
  assertCommandIsSafe(request.command);
  if (!policy.allowedCommands.some((rule) => commandMatches(rule, request.command))) {
    throw new Error('command is outside the routine command allowlist');
  }
}
