import { ThemeSettings } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { PageWrapper } from './page-wrapper';

export interface SettingsPageContentProps {
  children?: ReactNode;
}

export function SettingsPageContent({ children }: SettingsPageContentProps) {
  return (
    <PageWrapper title="Settings" description="Customize your application settings and preferences">
      <div className="space-y-6">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Appearance</h2>
          <ThemeSettings />
        </div>
        {children}
      </div>
    </PageWrapper>
  );
}
