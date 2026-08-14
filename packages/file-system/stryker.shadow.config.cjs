'use strict';
// @ts-check
const base = require('./stryker.config.cjs');

module.exports = {
  ...base,
  concurrency: 1,
  htmlReporter: {
    fileName: 'reports/shadow/mutation-gap.html',
  },
  jsonReporter: {
    fileName: 'reports/shadow/mutation-gap.json',
  },
  mutate: ['src/path-validation.ts'],
  reporters: ['json', 'html', 'clear-text'],
  thresholds: {
    ...base.thresholds,
    // Shadow reporting is deliberately score-non-gating. The repository's
    // actual Stryker threshold remains untouched in stryker.config.cjs.
    break: 0,
  },
  vitest: {
    ...base.vitest,
    configFile: 'vitest.mutation.shadow.config.ts',
  },
};
