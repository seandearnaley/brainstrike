import {
  SettingsPageContent as BaseSettingsPageContent,
  QueueHud,
  VectorStatusWithDb,
} from '@brainstrike/app-shell';
import { Badge } from '@brainstrike/ui';
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

        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Embedding Worker
            <Badge variant="secondary">experimental</Badge>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <QueueHud />
            <VectorStatusWithDb />
          </div>
        </div>
      </BaseSettingsPageContent>
    </>
  );
}
// Worker controls moved into Vector Status HUD to unify UX with DB panel
