import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import type { RuntimeAssistantMemorySettings } from '@brainstrike/assistant-contract/memory-settings';
import { Button } from '@brainstrike/ui';
import { Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';

/** One test embedding, as the host reports it (BST-2227). */
interface MemoryEmbedderTestResult {
  readonly dimensions: number;
  readonly latencyMs: number;
  /** The embedder's catalog `provider::model`. */
  readonly modelId: string;
}

/**
 * Embeds one fixed test text with the embedder these settings select, resolved
 * and credentialed as a run resolves it. Rejects with the embedder's typed failure.
 */
export type TestMemoryEmbedder = (
  settings: RuntimeAssistantMemorySettings
) => Promise<MemoryEmbedderTestResult>;

/** A test describes the target it ran against; a later selection hides it. */
type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'testing'; readonly target: string }
  | { readonly kind: 'passed'; readonly result: MemoryEmbedderTestResult; readonly target: string }
  | { readonly failure: BoundaryFailure; readonly kind: 'failed'; readonly target: string };

export interface MemoryEmbedderTestProps {
  /** The selected embedder's target; absent when none is selected. */
  readonly target: string | undefined;
  readonly testEmbedder: TestMemoryEmbedder;
}

function EmbedderTestFailure({ failure }: { readonly failure: BoundaryFailure }) {
  return (
    <div
      className="space-y-1 text-destructive text-xs"
      data-testid="assistant-memory-embedder-test-failure"
      role="alert"
    >
      <p>{failure.message}</p>
      {failure.providerEvidence !== undefined && <p>{failure.providerEvidence}</p>}
      {failure.remedy !== undefined && <p>{failure.remedy}</p>}
      {failure.correlationId !== undefined && (
        <p className="text-muted-foreground">Reference: {failure.correlationId}</p>
      )}
    </div>
  );
}

/** Settings → Assistant Memory's "Test embedder" (BST-2227). */
export function MemoryEmbedderTest({ target, testEmbedder }: MemoryEmbedderTestProps) {
  const [state, setState] = useState<TestState>({ kind: 'idle' });
  // Only the latest test may settle the state: an earlier target's slower answer is stale.
  const latest = useRef(0);
  const current = state.kind !== 'idle' && state.target === target ? state : undefined;
  const testing = current?.kind === 'testing';

  const test = async (): Promise<void> => {
    if (target === undefined) {
      return;
    }
    latest.current += 1;
    const request = latest.current;
    setState({ kind: 'testing', target });
    let settled: TestState;
    try {
      const result = await testEmbedder(
        useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings()
      );
      settled = { kind: 'passed', result, target };
    } catch (cause) {
      settled = {
        failure: cause instanceof BoundaryFailureError ? cause.failure : INTERNAL_FAULT,
        kind: 'failed',
        target,
      };
    }
    if (latest.current === request) {
      setState(settled);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        disabled={target === undefined || testing}
        onClick={() => {
          void test();
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {testing && (
          <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        )}
        Test embedder
      </Button>
      {target === undefined && (
        <p className="text-muted-foreground text-xs">Select an embedding model to test it.</p>
      )}
      {current?.kind === 'passed' && (
        <p
          className="text-muted-foreground text-xs"
          data-testid="assistant-memory-embedder-test-result"
          role="status"
        >
          {current.result.modelId} embedded the test text in {current.result.latencyMs} ms:{' '}
          {current.result.dimensions} dimensions.
        </p>
      )}
      {current?.kind === 'failed' && <EmbedderTestFailure failure={current.failure} />}
    </div>
  );
}
