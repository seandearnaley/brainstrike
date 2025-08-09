import type { UserConfig } from '@commitlint/types';
import { RuleConfigSeverity } from '@commitlint/types';

const Configuration: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  // Treat the entire first line as the subject so freeform headers are allowed
  parserPreset: {
    parserOpts: {
      headerPattern: /^(.*)$/,
      headerCorrespondence: ['subject'],
    },
  },
  rules: {
    // Relaxed rules to reduce friction while keeping helpful guidance
    // 1) Make type and scope optional (no emptiness or enum enforcement)
    'type-empty': [RuleConfigSeverity.Disabled],
    'scope-empty': [RuleConfigSeverity.Disabled],
    'type-enum': [RuleConfigSeverity.Disabled],
    'scope-enum': [RuleConfigSeverity.Disabled],

    // 2) Allow any casing for subject/type/scope; do not force starting character case
    'subject-case': [RuleConfigSeverity.Disabled],
    'type-case': [RuleConfigSeverity.Disabled],
    'scope-case': [RuleConfigSeverity.Disabled],

    // 3) Remove strict body/footers line-length limits
    'body-max-line-length': [RuleConfigSeverity.Disabled],
    'footer-max-line-length': [RuleConfigSeverity.Disabled],
  },
  defaultIgnores: true,
  helpUrl: 'https://github.com/conventional-changelog/commitlint/#what-is-commitlint',
};

export default Configuration;
