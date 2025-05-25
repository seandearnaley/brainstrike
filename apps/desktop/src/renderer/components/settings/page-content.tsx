import { Helmet } from 'react-helmet-async';

export default function SettingsPageContent() {
  return (
    <>
      <Helmet>
        <title>BrainStrike Desktop - Settings</title>
        <meta name="description" content="BrainStrike Desktop Settings" />
      </Helmet>
      <div className="container mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <div className="space-y-6">
          <div className="bg-card rounded-lg p-6 border">
            <h2 className="text-lg font-semibold mb-4">Desktop Preferences</h2>
            <p className="text-muted-foreground">
              Desktop-specific settings will be implemented here.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
