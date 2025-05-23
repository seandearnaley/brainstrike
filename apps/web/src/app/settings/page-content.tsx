import { PageWrapper } from '@brainstrike/app-shell';
import { ThemeSettings } from '@brainstrike/ui';
import { Helmet } from 'react-helmet-async';

export default function SettingsPageContent() {
  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta name="description" content="Customize your application settings" />
      </Helmet>

      <PageWrapper
        title="Settings"
        description="Customize your application settings and preferences"
      >
        <div className="space-y-6">
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Appearance</h2>
            <ThemeSettings />
          </div>

          {/* Add more settings sections here */}
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">More Settings</h2>
            <p className="text-sm text-muted-foreground">
              Additional settings will be added here in future updates.
            </p>
          </div>
        </div>
      </PageWrapper>
    </>
  );
}
