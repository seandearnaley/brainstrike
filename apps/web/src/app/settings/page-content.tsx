import { QueueHud, VectorStatusWithDb } from '@brainstrike/app-shell';
import {
  createAppearanceSettingsCategory,
  createTokenCountingSettingsCategory,
  LoggingSettingsSection,
  type SettingsCategory,
  SettingsPageContent as SettingsLayout,
} from '@brainstrike/preferences';
import { Badge } from '@brainstrike/ui';
import { Cpu, FileCog, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { Helmet } from 'react-helmet-async';

function EmbeddingWorkerCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          Embedding Worker
          <Badge variant="secondary">experimental</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">
          Monitor the embedding job queue and inspect vector store connectivity without leaving the
          settings screen.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QueueHud />
        <VectorStatusWithDb />
      </div>
    </div>
  );
}

function UpcomingPreferencesCategory() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          Coming Soon
          <Badge variant="outline">roadmap</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">
          We&apos;re actively expanding the BrainStrike web experience. Expect controls for
          authentication, workspace sharing, and assistant defaults in upcoming releases.
        </p>
      </div>
      <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
        <li>Bring-your-own models with project scoped secrets</li>
        <li>Context explorer defaults and search customisation</li>
        <li>Notifications and collaboration controls</li>
      </ul>
    </div>
  );
}

export default function SettingsPageContent() {
  const categories = useMemo<SettingsCategory[]>(
    () => [
      createAppearanceSettingsCategory(),
      createTokenCountingSettingsCategory(),
      {
        id: 'logging',
        title: 'Logging & Diagnostics',
        description: 'Control browser log verbosity and redaction for debugging.',
        keywords: ['logging', 'debugging', 'console', 'diagnostics'],
        icon: FileCog,
        render: () => <LoggingSettingsSection runtime="browser" />,
      },
      {
        id: 'embedding-worker',
        title: 'Embedding Worker',
        description: 'Check queue throughput and vector status for in-browser embeddings.',
        keywords: ['embeddings', 'worker', 'queue', 'vector', 'database'],
        icon: Cpu,
        render: () => <EmbeddingWorkerCategory />,
      },
      {
        id: 'upcoming',
        title: 'Upcoming Preferences',
        description: 'Preview the roadmap of controls arriving in the BrainStrike web console.',
        keywords: ['roadmap', 'coming soon', 'future'],
        icon: Sparkles,
        render: () => <UpcomingPreferencesCategory />,
      },
    ],
    []
  );

  return (
    <>
      <Helmet>
        <title>Settings - BrainStrike.ai</title>
        <meta name="description" content="Customize your application settings" />
      </Helmet>

      <SettingsLayout categories={categories} defaultCategoryId="appearance" />
    </>
  );
}
