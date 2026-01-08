import { createSystemDiagnosticsSettingsCategory } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createFactoryResetSettingsCategory,
  createTokenCountingSettingsCategory,
  LoggingSettingsSection,
  type LogSourceAdapter,
  ModelSelectionPage,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { FileCog, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { getWebLogBuffer } from '../../log-buffer';

function ModelSelectionCategory() {
  return (
    <div className="space-y-4">
      <ModelSelectionPage />
    </div>
  );
}

// Factory Reset category provided via createFactoryResetSettingsCategory()

export default function SettingsPageContent() {
  const logSource = useMemo<LogSourceAdapter>(() => {
    const buffer = getWebLogBuffer();
    return {
      getInitialRecords: async () => buffer.getRecords(),
      subscribe: (handler) => buffer.subscribe(handler),
    };
  }, []);
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'models',
        title: 'Models & Providers',
        description: 'Manage AI providers and enable/disable specific models.',
        keywords: ['models', 'providers', 'llm', 'embedding', 'vector'],
        icon: Layers,
        render: () => <ModelSelectionCategory />,
      },
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        render: () => <LoggingSettingsSection logSource={logSource} runtime="browser" />,
      },
      createSystemDiagnosticsSettingsCategory(),
      createFactoryResetSettingsCategory(),
    ],
    [logSource]
  );

  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta content="Customize your application settings" name="description" />
      </Helmet>

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
