import type { UserConfig } from '@commitlint/types';
import { RuleConfigSeverity } from '@commitlint/types';

const Configuration: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      RuleConfigSeverity.Error,
      'always',
      [
        'build', // Changes that affect the build system or external dependencies
        'chore', // Maintenance tasks and minor updates
        'ci', // Changes to CI configuration files and scripts
        'docs', // Documentation only changes
        'feat', // A new feature
        'fix', // A bug fix
        'perf', // A code change that improves performance
        'refactor', // A code change that neither fixes a bug nor adds a feature
        'revert', // Revert a previous commit
        'style', // Changes that do not affect the meaning of the code
        'test', // Adding missing tests or correcting existing tests
        'release', // Release commits managed by semantic-release
      ],
    ],
    'scope-enum': [
      RuleConfigSeverity.Error,
      'always',
      [
        'auth', // Authentication related changes
        'api', // API related changes
        'ui', // UI components and styling
        'config', // Configuration changes
        'deps', // Dependency updates
        'core', // Core functionality
        'test', // Test infrastructure changes
        'types', // TypeScript type changes
        'security', // Security related changes
        'dx', // Developer experience improvements
      ],
    ],
  },
  defaultIgnores: true,
  helpUrl: 'https://github.com/conventional-changelog/commitlint/#what-is-commitlint',
};

export default Configuration;
