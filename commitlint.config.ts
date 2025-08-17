import type { UserConfig } from '@commitlint/types';
import { RuleConfigSeverity } from '@commitlint/types';

// Liberal commit message rules to reduce friction:
// - No required type or scope
// - Subject casing unrestricted (allow lower or upper case)
// - Increase body max line length to 500
const Configuration: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Do not require a commit type or restrict which types can be used
    'type-empty': [RuleConfigSeverity.Off],
    'type-enum': [RuleConfigSeverity.Off],
    'type-case': [RuleConfigSeverity.Off],

    // Do not require or restrict scope
    'scope-empty': [RuleConfigSeverity.Off],
    'scope-enum': [RuleConfigSeverity.Off],
    'scope-case': [RuleConfigSeverity.Off],

    // Allow any subject casing and formatting
    'subject-case': [RuleConfigSeverity.Off],

    // Make body lines much longer before warning/error
    'body-max-line-length': [RuleConfigSeverity.Error, 'always', 500],

    // Keep other restrictions minimal
    'header-max-length': [RuleConfigSeverity.Off],
    'subject-empty': [RuleConfigSeverity.Off],
  },
  defaultIgnores: true,
  helpUrl: 'https://github.com/conventional-changelog/commitlint/#what-is-commitlint',
};

export default Configuration;
