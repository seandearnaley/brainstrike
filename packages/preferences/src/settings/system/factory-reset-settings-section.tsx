import { FactoryResetPanel } from './factory-reset-panel';

export function FactoryResetSettingsSection() {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-lg">Factory Reset</h3>
        <p className="text-muted-foreground text-sm">
          Wipe application data (files, embeddings, queues) and reset preferences.
        </p>
      </div>
      <FactoryResetPanel />
    </div>
  );
}
