import { FolderLock } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import {
  WorkspaceTrustSettingsSection,
  type WorkspaceTrustSettingsSectionProps,
} from './workspace-trust-settings-section';

/**
 * Factory for the Workspace trust settings category (ADR-0032). Lives in its
 * own (non-component) module, like `skills-settings-category.tsx`, so Fast
 * Refresh can preserve `SettingsPageContent`'s state. Registered by the
 * DESKTOP settings page only, with the agent host's trust.
 */
export function createWorkspaceTrustSettingsCategory(
  options: WorkspaceTrustSettingsSectionProps
): SettingsCategory {
  return {
    content: <WorkspaceTrustSettingsSection {...options} />,
    description:
      'Choose which folders may load their AGENTS.md, skills, slash commands and subagents.',
    icon: FolderLock,
    id: 'workspace-trust',
    keywords: [
      'trust',
      'workspace trust',
      'restricted',
      'folder',
      'agents.md',
      'claude.md',
      'skills',
      'commands',
      'subagents',
      'security',
    ],
    title: 'Workspace trust',
  };
}
