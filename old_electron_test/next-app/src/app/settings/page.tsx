'use client';

import { ThemeSettings } from '@/components/custom/settings/theme-settings';

export default function SettingsPage() {
  return (
    <div className="container max-w-2xl mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8">Settings</h1>

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
    </div>
  );
}
