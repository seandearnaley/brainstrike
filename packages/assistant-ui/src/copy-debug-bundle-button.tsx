import { useAuiState } from '@assistant-ui/react';
import { readAssistantRunEventDataPart } from '@brainstrike/assistant-contract';
import { Button, saveDownload } from '@brainstrike/ui';
import { Predicate } from 'effect';
import { ClipboardCopy, Download } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useDebugBundleContext } from './debug-bundle-context';
import { formatDebugBundleFilename } from './debug-bundle-download';

/**
 * The runId of THIS message's `run.failed` event, or null. Mirrors
 * `selectFinishedRunId` in run-verdict-control.tsx (same part-walk over
 * `ASSISTANT_RUN_EVENT_DATA_NAME` data parts), but matches `run.failed`
 * instead of `run.finished` — the debug bundle is a FAILURE artifact.
 *
 * Not exported: only used within this module (by `CopyDebugBundleButton`
 * below); tests exercise it indirectly through the component's rendered
 * behavior. Keeping this module component-only satisfies react-refresh's
 * `only-export-components` (Fast Refresh boundary).
 */
function selectFailedRunId(parts: readonly unknown[]): string | null {
  for (const part of parts) {
    const data = readAssistantRunEventDataPart(part);
    if (data?.kind === 'run.failed' && data.runId !== undefined) {
      return data.runId;
    }
  }
  return null;
}

/**
 * True when THIS message carries assistant-ui's own error state — the exact
 * check `ErrorPrimitive.Message` / the library's internal `useMessageError`
 * perform (`status.type === 'incomplete' && status.reason === 'error'`).
 * Read directly via `useAuiState` (same `state.message.status` selector
 * pattern already used by `ActivityGroup` in assistant-activity-parts.tsx)
 * since `useMessageError` itself is not re-exported from `@assistant-ui/react`'s
 * public surface.
 */
function selectHasErrorState(state: { message: unknown }): boolean {
  const status = Predicate.isObject(state.message)
    ? (state.message as { status?: { reason?: string; type?: string } }).status
    : undefined;
  return status?.type === 'incomplete' && status?.reason === 'error';
}

function formatKb(byteLength: number): string {
  return Math.max(1, Math.round(byteLength / 1024)).toString();
}

/** Which of the two delivery actions a phase belongs to. Carried on every
 * non-idle phase so the OTHER button never borrows this one's spinner,
 * result, or error. */
type BundleAction = 'copy' | 'download';

type ButtonPhase =
  | { readonly kind: 'idle' }
  | { readonly action: BundleAction; readonly kind: 'building' }
  | { readonly action: BundleAction; readonly kb: string; readonly kind: 'done' }
  | { readonly action: BundleAction; readonly kind: 'error'; readonly message: string };

const COPIED_RESET_MS = 3000;

/**
 * Debug-bundle delivery footer (Flight Recorder capstone, Task 9; download
 * added in BST-946). Renders null without a `DebugBundleProvider` binding
 * (capability gating) OR when the message carries neither a `run.failed`
 * run-event part nor assistant-ui's own error state — the two failure signals
 * a failed assistant turn can surface.
 *
 * Two peers, one bundle build each: **Copy** for a quick paste, **Download**
 * for the realistic case — bundles run up to `DEBUG_BUNDLE_DEFAULT_MAX_BYTES`
 * (200 KB), well past what a chat box or issue comment takes, so a
 * timestamped `.md` on disk is the transport that actually survives. Copy
 * shows its result and any failure inline; Download confirms in a toast, as
 * every download does. Never a silent drop.
 */
export function CopyDebugBundleButton(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const runId = useMemo(() => selectFailedRunId(parts), [parts]);
  const hasErrorState = useAuiState(selectHasErrorState);
  const context = useDebugBundleContext();
  const [phase, setPhase] = useState<ButtonPhase>({ kind: 'idle' });
  // Tracks the pending "copied → idle" revert timer so a later click (or
  // unmount) can cancel a STALE one — untracked, it can fire after a second
  // click already started a newer cycle and clobber that cycle's state (or
  // fire post-unmount).
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending "copied → idle" revert timer on unmount.
  // biome-ignore lint/plugin: unmount-only timer cleanup — not a state-as-event-handler effect
  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== null) {
        clearTimeout(resetTimeoutRef.current);
      }
    },
    []
  );

  if (!(context && (runId || hasErrorState))) {
    return null;
  }

  const run = async (action: BundleAction): Promise<void> => {
    if (resetTimeoutRef.current !== null) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
    setPhase({ action, kind: 'building' });
    if (action === 'download') {
      // The toast says where it went, or why it did not save.
      await saveDownload({
        build: async () => ({
          blob: new Blob([await context.buildBundle({ runId })], {
            type: 'text/markdown;charset=utf-8',
          }),
          filename: formatDebugBundleFilename({ generatedAt: new Date(), runId }),
        }),
        what: 'debug bundle',
      });
      setPhase({ kind: 'idle' });
      return;
    }
    try {
      const bundle = await context.buildBundle({ runId });
      await navigator.clipboard.writeText(bundle);
      setPhase({ action, kb: formatKb(new TextEncoder().encode(bundle).length), kind: 'done' });
      resetTimeoutRef.current = setTimeout(() => {
        resetTimeoutRef.current = null;
        setPhase({ kind: 'idle' });
      }, COPIED_RESET_MS);
    } catch (error) {
      setPhase({
        action,
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const labelFor = (action: BundleAction, idleLabel: string): string => {
    if (phase.kind === 'idle' || phase.action !== action) {
      return idleLabel;
    }
    if (phase.kind === 'building') {
      return 'Building…';
    }
    if (phase.kind === 'done') {
      return `Copied · ${phase.kb} KB`;
    }
    return idleLabel;
  };

  const busy = phase.kind === 'building';

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="copy-debug-bundle-footer">
      <Button
        className="text-muted-foreground h-5 gap-1 px-1.5 text-[11px]"
        data-testid="copy-debug-bundle"
        disabled={busy}
        onClick={() => void run('copy')}
        size="sm"
        variant="ghost"
      >
        <ClipboardCopy aria-hidden="true" className="size-3" />
        {labelFor('copy', 'Copy debug bundle')}
      </Button>
      <Button
        className="text-muted-foreground h-5 gap-1 px-1.5 text-[11px]"
        data-testid="download-debug-bundle"
        disabled={busy}
        onClick={() => void run('download')}
        size="sm"
        title="Save the debug bundle as a timestamped Markdown file"
        variant="ghost"
      >
        <Download aria-hidden="true" className="size-3" />
        {labelFor('download', 'Download .md')}
      </Button>
      {/* Live region: the result lands in the button label, but a failure is
          the only place the reason appears at all. */}
      <span aria-live="polite" className="text-destructive text-[11px]" role="status">
        {phase.kind === 'error' ? `Copy failed: ${phase.message}` : ''}
      </span>
    </div>
  );
}
