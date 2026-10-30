import { Button, saveDownload } from '@brainstrike/ui';
import { formatTimestampedDownloadFilename } from '@brainstrike/utils/browser-download';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useDebugBundleContext } from './debug-bundle-context';

/** Thread-scoped: deliberately usable without a message or failure runtime. */
export function ThreadDebugPackButton() {
  const context = useDebugBundleContext();
  const [building, setBuilding] = useState(false);
  if (!context?.buildThreadPack) {
    return null;
  }
  const buildThreadPack = context.buildThreadPack;
  const download = async (): Promise<void> => {
    setBuilding(true);
    await saveDownload({
      build: async () => ({
        blob: new Blob([await buildThreadPack()], { type: 'application/json;charset=utf-8' }),
        filename: formatTimestampedDownloadFilename({
          extension: 'json',
          generatedAt: new Date(),
          name: 'brainstrike-thread-debug',
        }),
      }),
      what: 'debug pack',
    });
    setBuilding(false);
  };
  return (
    <details className="text-muted-foreground shrink-0 px-3 py-1 text-xs">
      <summary className="cursor-pointer text-right">Debug pack</summary>
      <p className="py-2">
        Includes this conversation and its subagents: messages, tool inputs and results, approvals
        and live decisions, the prompts each leg and specialist received, parent wakeups, run
        settings, per-leg model identity and diagnostics. On desktop it also includes the
        main-process log for the run window and process counters. Saved locally; review private
        conversation and file content before sharing.
      </p>
      <Button
        className="text-muted-foreground h-7 gap-1 text-xs"
        disabled={building}
        onClick={() => void download()}
        size="sm"
        title="Save this thread and its subagents: messages, tool inputs/results, approvals and live decisions, leg and specialist prompts, parent wakeups, run settings, per-leg model identity and diagnostics; on desktop also the main-process log for the run window and process counters. May contain private conversation and file content. Review locally before sharing."
        variant="ghost"
      >
        <Download aria-hidden="true" className="size-3" />
        {building ? 'Building debug pack…' : 'Download debug pack'}
      </Button>
    </details>
  );
}
