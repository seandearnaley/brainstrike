import { SettingsPageContent as BaseSettingsPageContent } from '@brainstrike/app-shell';
import { Helmet } from 'react-helmet-async';

export default function SettingsPageContent() {
  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta name="description" content="Customize your application settings" />
      </Helmet>

      <BaseSettingsPageContent>
        {/* Add web-specific settings sections here */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">More Settings</h2>
          <p className="text-sm text-muted-foreground">
            Additional settings will be added here in future updates.
          </p>
        </div>
      </BaseSettingsPageContent>
    </>
  );
}
