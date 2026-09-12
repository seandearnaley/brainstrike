import { Button } from '@brainstrike/ui';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useDebugBundleContext } from './debug-bundle-context';

type Phase = { kind: 'idle' | 'building' | 'saved' } | { kind: 'error'; message: string };

/** Thread-scoped: deliberately usable without a message or failure runtime. */
export function ThreadDebugPackButton() {
  const context = useDebugBundleContext();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  if (!context?.buildThreadPack) {
    return null;
  }
  const buildThreadPack = context.buildThreadPack;
  const download = async (): Promise<void> => {
    setPhase({ kind: 'building' });
    try {
      const contents = await buildThreadPack();
      await downloadBlobFile({
        blob: new Blob([contents], { type: 'application/json;charset=utf-8' }),
        filename: formatTimestampedDownloadFilename({
          extension: 'json',
          generatedAt: new Date(),
          name: 'brainstrike-thread-debug',
        }),
      });
      setPhase({ kind: 'saved' });
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <details className="shrink-0 px-3 py-1 text-muted-foreground text-xs">
      <summary className="cursor-pointer text-right">Debug pack</summary>
      <p className="py-2">
        Includes this conversation and its subagents, messages, tool inputs and results, approvals,
        run settings and diagnostics. Saved locally; review private conversation and file content
        before sharing.
      </p>
      <Button
        className="h-7 gap-1 text-muted-foreground text-xs"
        disabled={phase.kind === 'building'}
        onClick={() => void download()}
        size="sm"
        title="Save this thread and its subagents: messages, tool inputs/results, approvals, run settings and diagnostics. May contain private conversation and file content. Review locally before sharing."
        variant="ghost"
      >
        <Download aria-hidden="true" className="size-3" />
        {phase.kind === 'building' ? 'Building debug pack…' : 'Download debug pack'}
      </Button>
      <span aria-live="polite" className="text-xs" role="status">
        {phase.kind === 'error' ? `Download failed: ${phase.message}` : null}
        {phase.kind === 'saved' ? 'Debug pack saved. Review before sharing.' : null}
      </span>
    </details>
  );
}
