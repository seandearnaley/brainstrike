import { TrendingUp } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { SelfImprovementSignalSettingsSection } from './self-improvement-signal-settings-section';

/** Desktop-only category for the opt-in self-improvement signal. */
export function createSelfImprovementSignalSettingsCategory(): SettingsCategory {
  return {
    content: <SelfImprovementSignalSettingsSection />,
    description: 'Let the assistant adapt to its recent tool-usage waste patterns.',
    icon: TrendingUp,
    id: 'self-improvement-signal',
    keywords: ['self-improvement', 'tool telemetry', 'waste', 'truncation', 'zero match'],
    title: 'Self-improvement signal',
  };
}
