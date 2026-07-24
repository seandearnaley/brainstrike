import { useAuiState } from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { type ReactElement, useMemo, useState } from 'react';
import { Button } from '../button';
import { useDebugBundleContext } from './debug-bundle-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * The runId of THIS message's `run.failed` event, or null. Mirrors
 * `selectFinishedRunId` in run-verdict-control.tsx (same part-walk over
 * `ASSISTANT_RUN_EVENT_DATA_NAME` data parts), but matches `run.failed`
 * instead of `run.finished` — the debug bundle is a FAILURE artifact.
 */
export function selectFailedRunId(parts: readonly unknown[]): string | null {
  for (const part of parts) {
    if (!isRecord(part) || part['name'] !== ASSISTANT_RUN_EVENT_DATA_NAME) {
      continue;
    }
    const data = part['data'];
    if (isRecord(data) && data['kind'] === 'run.failed' && typeof data['runId'] === 'string') {
      return data['runId'];
    }
  }
  return null;
}

/**
 * True when THIS message carries assistant-ui's own error state — the exact
 * check `ErrorPrimitive.Message` / the library's internal `useMessageError`
 * perform (`status.type === 'incomplete' && status.reason === 'error'`).
 * Read directly via `useAuiState` (same `state.message.status` selector
 * pattern already used by `LocalChainOfThought` in assistant-ui-panel.tsx)
 * since `useMessageError` itself is not re-exported from `@assistant-ui/react`'s
 * public surface.
 */
function selectHasErrorState(state: { message: unknown }): boolean {
  const status = isRecord(state.message)
    ? (state.message as { status?: { reason?: string; type?: string } }).status
    : undefined;
  return status?.type === 'incomplete' && status?.reason === 'error';
}

function formatKb(byteLength: number): string {
  return Math.max(1, Math.round(byteLength / 1024)).toString();
}

type ButtonPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'building' }
  | { readonly kind: 'copied'; readonly kb: string }
  | { readonly kind: 'error'; readonly message: string };

const COPIED_RESET_MS = 3000;

/**
 * Copy-debug-bundle button (Flight Recorder capstone, Task 9). Renders null
 * without a `DebugBundleProvider` binding (capability gating) OR when the
 * message carries neither a `run.failed` run-event part nor assistant-ui's
 * own error state — the two failure signals a failed assistant turn can
 * surface. Clipboard/build failures are shown inline; never a silent drop.
 */
export function CopyDebugBundleButton(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const runId = useMemo(() => selectFailedRunId(parts), [parts]);
  const hasErrorState = useAuiState(selectHasErrorState);
  const context = useDebugBundleContext();
  const [phase, setPhase] = useState<ButtonPhase>({ kind: 'idle' });

  if (!(context && (runId || hasErrorState))) {
    return null;
  }

  const handleClick = async (): Promise<void> => {
    setPhase({ kind: 'building' });
    try {
      const bundle = await context.buildBundle({ runId });
      await navigator.clipboard.writeText(bundle);
      setPhase({ kb: formatKb(new TextEncoder().encode(bundle).length), kind: 'copied' });
      setTimeout(() => setPhase({ kind: 'idle' }), COPIED_RESET_MS);
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const label =
    phase.kind === 'building'
      ? 'Building…'
      : phase.kind === 'copied'
        ? `Copied · ${phase.kb} KB`
        : 'Copy debug bundle';

  return (
    <div className="mt-1 flex items-center gap-1.5" data-testid="copy-debug-bundle-footer">
      <Button
        className="h-5 px-1.5 text-[11px] text-muted-foreground"
        data-testid="copy-debug-bundle"
        disabled={phase.kind === 'building'}
        onClick={() => void handleClick()}
        size="sm"
        variant="ghost"
      >
        {label}
      </Button>
      {phase.kind === 'error' ? (
        <span className="text-[11px] text-destructive">Copy failed: {phase.message}</span>
      ) : null}
    </div>
  );
}
