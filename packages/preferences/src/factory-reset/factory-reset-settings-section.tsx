import { FactoryResetPanel } from './factory-reset-panel';

export function FactoryResetSettingsSection() {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Factory Reset</h3>
        <p className="text-sm text-muted-foreground">
          Wipe application data (files, embeddings, queues) and reset preferences.
        </p>
      </div>
      <FactoryResetPanel />
    </div>
  );
}
