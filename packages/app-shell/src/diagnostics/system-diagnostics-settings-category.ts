import { Activity, type LucideIcon } from 'lucide-react';
import { createElement, type ReactNode } from 'react';
import { ConnectedSystemDiagnosticsPanel } from './connected-system-diagnostics-panel';

export interface DiagnosticsSettingsCategory {
  readonly content: ReactNode;
  readonly description?: string;
  readonly icon?: LucideIcon;
  readonly id: string;
  readonly keywords?: string[];
  readonly title: string;
}

/** Creates the app settings category that hosts connected diagnostics. */
export function createSystemDiagnosticsSettingsCategory(): DiagnosticsSettingsCategory {
  return {
    content: createElement(ConnectedSystemDiagnosticsPanel),
    description: 'Monitor database, queue, and worker health in real-time.',
    icon: Activity,
    id: 'system-diagnostics',
    keywords: ['diagnostics', 'health', 'status', 'database', 'queue', 'worker', 'monitoring'],
    title: 'System Diagnostics',
  };
}
