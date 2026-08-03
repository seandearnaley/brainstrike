import { Bell } from 'lucide-react';
import type { SettingsCategory } from '../../settings-page-content';
import { NotificationSettingsSection } from './notification-settings-section';

/**
 * Factory for the Notifications settings category. It lives in its own
 * (non-component) module rather than `settings-page-content.tsx` so Fast
 * Refresh can preserve `SettingsPageContent`'s state — a component file that
 * also exports plain factories defeats it (react-doctor
 * `only-export-components`).
 */
export function createNotificationSettingsCategory(): SettingsCategory {
  return {
    content: <NotificationSettingsSection />,
    description: 'Get an OS notification when a run finishes, fails, or needs your approval.',
    icon: Bell,
    id: 'notifications',
    keywords: [
      'notifications',
      'notification',
      'desktop notification',
      'alert',
      'run finished',
      'run failed',
      'tool approval',
    ],
    title: 'Notifications',
  };
}
