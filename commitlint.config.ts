import type { UserConfig } from '@commitlint/types';
import { RuleConfigSeverity } from '@commitlint/types';

const Configuration: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Relaxed rules
    // Allow commits without a type and without restricting the type to a fixed set
    'type-empty': [RuleConfigSeverity.Disabled],
    'type-enum': [RuleConfigSeverity.Disabled],
    // Allow any scope (or none)
    'scope-enum': [RuleConfigSeverity.Disabled],
    // Allow empty subject and relax casing rules
    'subject-empty': [RuleConfigSeverity.Disabled],
    'subject-case': [RuleConfigSeverity.Disabled],
    // Relax body length rules
    'body-max-line-length': [RuleConfigSeverity.Disabled],
  },
  defaultIgnores: true,
  helpUrl: 'https://github.com/conventional-changelog/commitlint/#what-is-commitlint',
};

export default Configuration;
