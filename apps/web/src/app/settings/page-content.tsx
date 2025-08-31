import { SettingsPageContent as BaseSettingsPageContent, QueueHud } from '@brainstrike/app-shell';
import { usePGliteDatabase } from '@brainstrike/db';
import { Badge, Button } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { startEmbeddingWorkerWeb } from '../../workers/embedding-worker-web';

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
            <WebWorkerControls />
            <QueueHud />
          </div>
        </div>
      </BaseSettingsPageContent>
    </>
  );
}

function WebWorkerControls() {
  const db = usePGliteDatabase();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const controllerRef = useMemo<{ current: null | { stop: () => Promise<void> } }>(
    () => ({ current: null }),
    []
  );

  const start = useCallback(async () => {
    if (!db || running) return;
    setBusy(true);
    try {
      const c = await startEmbeddingWorkerWeb(db);
      controllerRef.current = c;
      setRunning(true);
    } finally {
      setBusy(false);
    }
  }, [db, running, controllerRef]);

  const stop = useCallback(async () => {
    if (!running) return;
    setBusy(true);
    try {
      await controllerRef.current?.stop();
      controllerRef.current = null;
      setRunning(false);
    } finally {
      setBusy(false);
    }
  }, [running, controllerRef]);

  return (
    <div className="flex items-center gap-3">
      <div className="text-sm">
        Status: {running ? <Badge>running</Badge> : <Badge variant="outline">stopped</Badge>}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || running || !db} onClick={start}>
          Start Worker
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !running} onClick={stop}>
          Stop Worker
        </Button>
      </div>
    </div>
  );
}
