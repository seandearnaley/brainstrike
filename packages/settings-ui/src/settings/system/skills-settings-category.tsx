import { Sparkles } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { SkillsSettingsSection, type SkillsSettingsSectionProps } from './skills-settings-section';

/**
 * Factory for the Agent Skills settings category. Lives in its own
 * (non-component) module rather than `settings-page-content.tsx` so Fast
 * Refresh can preserve `SettingsPageContent`'s state (react-refresh
 * `only-export-components`), mirroring `workspace-instructions-settings-category.tsx`.
 * Registered by the DESKTOP settings page only, with the agent host's scan.
 */
export function createSkillsSettingsCategory(
  options: SkillsSettingsSectionProps
): SettingsCategory {
  return {
    content: <SkillsSettingsSection {...options} />,
    description:
      'Teach the assistant specialized workflows with Agent Skills (SKILL.md folders in .brainstrike/skills or .claude/skills).',
    icon: Sparkles,
    id: 'skills',
    keywords: [
      'skills',
      'agent skills',
      'skill.md',
      'claude skills',
      'workflows',
      'instructions',
      'progressive disclosure',
      'available skills',
      'enable agent skills',
    ],
    title: 'Skills',
  };
}
