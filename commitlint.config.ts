import type { UserConfig } from '@commitlint/types';
import { RuleConfigSeverity } from '@commitlint/types';

// Liberal commit message rules to reduce friction:
// - No required type or scope
// - Subject casing unrestricted (allow lower or upper case)
// - Increase body max line length to 500
const Configuration: UserConfig = {
  defaultIgnores: true,
  extends: ['@commitlint/config-conventional'],
  helpUrl: 'https://github.com/conventional-changelog/commitlint/#what-is-commitlint',
  rules: {
    // Make body lines much longer before warning/error
    'body-max-line-length': [RuleConfigSeverity.Error, 'always', 500],

    // Keep other restrictions minimal
    'header-max-length': [RuleConfigSeverity.Disabled],
    'scope-case': [RuleConfigSeverity.Disabled],

    // Do not require or restrict scope
    'scope-empty': [RuleConfigSeverity.Disabled],
    'scope-enum': [RuleConfigSeverity.Disabled],

    // Allow any subject casing and formatting
    'subject-case': [RuleConfigSeverity.Disabled],
    'subject-empty': [RuleConfigSeverity.Disabled],
    'type-case': [RuleConfigSeverity.Disabled],
    // Do not require a commit type or restrict which types can be used
    'type-empty': [RuleConfigSeverity.Disabled],
    'type-enum': [RuleConfigSeverity.Disabled],
  },
};

export default Configuration;
