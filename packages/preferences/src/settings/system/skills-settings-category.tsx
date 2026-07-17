import { Sparkles } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { SkillsSettingsSection } from './skills-settings-section';

/**
 * Factory for the Agent Skills settings category. Lives in its own
 * (non-component) module rather than `settings-page-content.tsx` so Fast
 * Refresh can preserve `SettingsPageContent`'s state (react-doctor
 * `only-export-components`), mirroring `workspace-instructions-settings-category.tsx`.
 * Registered by the DESKTOP settings page only — web has no skills bridge.
 */
export function createSkillsSettingsCategory(): SettingsCategory {
  return {
    content: <SkillsSettingsSection />,
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
    ],
    title: 'Skills',
  };
}
