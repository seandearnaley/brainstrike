import { SettingsPageContent as BaseSettingsPageContent } from '@brainstrike/app-shell';

export default function SettingsPageContent() {
  return (
    <>
      <title>BrainStrike Desktop - Settings</title>
      <meta name="description" content="BrainStrike Desktop Settings" />

      <BaseSettingsPageContent>
        {/* Add desktop-specific settings sections here */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Desktop Preferences</h2>
          <p className="text-sm text-muted-foreground">
            Desktop-specific settings will be implemented here.
          </p>
        </div>
      </BaseSettingsPageContent>
    </>
  );
}
