import { FileText } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { WorkspaceInstructionsSettingsSection } from './workspace-instructions-settings-section';

/**
 * Factory for the Workspace Instructions settings category. Lives in its own
 * (non-component) module rather than `settings-page-content.tsx` so Fast Refresh
 * can preserve `SettingsPageContent`'s state (react-doctor
 * `only-export-components`), mirroring `notification-settings-category.tsx`.
 */
export function createWorkspaceInstructionsSettingsCategory(): SettingsCategory {
  return {
    content: <WorkspaceInstructionsSettingsSection />,
    description:
      'Auto-inject each open workspace folder’s AGENTS.md / AGENT.md / CLAUDE.md into the assistant’s context.',
    icon: FileText,
    id: 'workspace-instructions',
    keywords: [
      'workspace instructions',
      'context files',
      'agents.md',
      'agent.md',
      'claude.md',
      'system prompt',
      'conventions',
      'auto-inject',
    ],
    title: 'Workspace Instructions',
  };
}
