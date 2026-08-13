import { TrendingUp } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { ExperimentAssignmentSettingsSection } from './experiment-assignment-settings-section';
import { SelfImprovementSignalSettingsSection } from './self-improvement-signal-settings-section';

/**
 * Desktop-only category for the opt-in self-improvement signal and the
 * companion experiment-enrollment fields (BST-1251) that attribute its runs.
 */
export function createSelfImprovementSignalSettingsCategory(): SettingsCategory {
  return {
    content: (
      <div className="space-y-6">
        <SelfImprovementSignalSettingsSection />
        <ExperimentAssignmentSettingsSection />
      </div>
    ),
    description: 'Let the assistant adapt to its recent tool-usage waste patterns.',
    icon: TrendingUp,
    id: 'self-improvement-signal',
    keywords: [
      'self-improvement',
      'tool telemetry',
      'waste',
      'truncation',
      'zero match',
      'experiment',
      'variant',
      'enrollment',
    ],
    title: 'Self-improvement signal',
  };
}
