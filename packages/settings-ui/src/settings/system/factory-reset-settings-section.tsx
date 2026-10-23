import { ClearContentPanel, type ClearContentProps } from './clear-content-panel';
import { ClearStoredFoldersPanel } from './clear-stored-folders-panel';
import { FactoryResetPanel } from './factory-reset-panel';
import { InlineFixtureSettingsPanel } from './inline-fixture-settings-panel';

export interface FactoryResetSettingsSectionProps {
  /** Clears content through Main while keeping configuration */
  clearContent?: ClearContentProps | undefined;
  /** Whether stored folders exist */
  hasStoredFolders?: boolean | undefined;
  /** Inline fixture settings (developer feature) */
  inlineFixtureSetting?:
    | {
        available: boolean;
        loading: boolean;
        checked: boolean;
        onChange: (checked: boolean) => void;
      }
    | undefined;
  /** Whether running on web platform. Defaults to true. */
  isWebPlatform?: boolean | undefined;
  /** Callback to clear stored folders */
  onClearStoredFolders?: (() => void) | undefined;
}

export function FactoryResetSettingsSection({
  clearContent,
  isWebPlatform = true,
  hasStoredFolders = false,
  onClearStoredFolders,
  inlineFixtureSetting,
}: FactoryResetSettingsSectionProps = {}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold text-lg">Factory Reset</h3>
        <p className="text-muted-foreground text-sm">
          Wipe application data (files, embeddings, queues) and reset preferences.
        </p>
      </div>
      {clearContent ? <ClearContentPanel {...clearContent} /> : null}
      <FactoryResetPanel />
      <ClearStoredFoldersPanel
        hasStoredFolders={hasStoredFolders}
        isWebPlatform={isWebPlatform}
        onClearFolders={onClearStoredFolders ?? (() => {})}
      />
      {inlineFixtureSetting && (
        <InlineFixtureSettingsPanel
          checked={inlineFixtureSetting.checked}
          isAvailable={inlineFixtureSetting.available}
          isLoading={inlineFixtureSetting.loading}
          onChange={inlineFixtureSetting.onChange}
        />
      )}
    </div>
  );
}
