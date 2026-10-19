/**
 * The Developer-level Memory panel inside the Context Usage popover (BST-2201):
 * what the host's memory read reports for the next send, field by field. A
 * value the host did not report is labelled, never filled in.
 */
import { type ReactNode, useId } from 'react';
import type { MemoryModelsDisplay, OmMeterState, OmRecordLifecycle } from './context-usage-meter';

const NOT_REPORTED = 'Not reported by this host';

interface PanelRow {
  readonly id: string;
  readonly label: string;
  readonly tone?: 'error';
  readonly value: ReactNode;
}

function exact(count: number): string {
  return count.toLocaleString('en-US');
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
  second: '2-digit',
});

function storedTime(epochMs: number | null): ReactNode {
  if (epochMs === null) {
    return 'Never';
  }
  const date = new Date(epochMs);
  return <time dateTime={date.toISOString()}>{TIME_FORMAT.format(date)}</time>;
}

function liveFlags(lifecycle: OmRecordLifecycle): string {
  const active = [
    lifecycle.isObserving && 'Observing',
    lifecycle.isReflecting && 'Reflecting',
    lifecycle.isBufferingObservation && 'Buffering observation',
    lifecycle.isBufferingReflection && 'Buffering reflection',
  ].filter((flag) => typeof flag === 'string');
  return active.length > 0 ? active.join(' · ') : 'Idle';
}

function lifecycleRows(
  state: Extract<OmMeterState, { kind: 'stats' }>,
  lifecycle: OmRecordLifecycle
): PanelRow[] {
  return [
    { id: 'live', label: 'Live', value: liveFlags(lifecycle) },
    { id: 'last-observed', label: 'Last observed', value: storedTime(lifecycle.lastObservedAt) },
    {
      id: 'last-buffered',
      label: 'Last buffered',
      value: storedTime(lifecycle.lastBufferedAtTime),
    },
    {
      id: 'generation',
      label: 'Generation',
      value: `${lifecycle.generationCount} (${
        lifecycle.originType === 'reflection' ? 'from a reflection' : 'initial'
      })`,
    },
    {
      id: 'reflect-threshold',
      label: 'Reflect at',
      value: `${exact(state.observationTokens)} / ${exact(lifecycle.reflectionTokenThreshold)} observation tokens`,
    },
  ];
}

function recordRows(state: Extract<OmMeterState, { kind: 'stats' }>): PanelRow[] {
  return [
    {
      id: 'observe-threshold',
      label: 'Observe at',
      value: `${exact(state.pendingMessageTokens)} / ${exact(state.messageTokenThreshold)} message tokens`,
    },
    ...(state.lifecycle
      ? lifecycleRows(state, state.lifecycle)
      : [{ id: 'lifecycle', label: 'Lifecycle', value: NOT_REPORTED }]),
  ];
}

function observerValue(state: OmMeterState, models: MemoryModelsDisplay | undefined): string {
  if (state.kind === 'inactive') {
    return 'Off';
  }
  if (state.kind === 'awaiting-observer') {
    return `Waiting (${state.reason})`;
  }
  if (!models) {
    return NOT_REPORTED;
  }
  return models.observer ?? 'None';
}

function embedderValue(models: MemoryModelsDisplay | undefined): string {
  if (!models) {
    return NOT_REPORTED;
  }
  const { embedder } = models;
  if (!embedder) {
    return 'Off';
  }
  return [
    embedder.provider,
    embedder.modelId,
    `${exact(embedder.dimensions)} dims`,
    embedder.distance,
    ...(embedder.dtype === undefined ? [] : [embedder.dtype]),
  ].join(' · ');
}

/** The rows a read state has; null for states with no host read behind them. */
function stateRows(state: OmMeterState): PanelRow[] | null {
  switch (state.kind) {
    case 'error':
      return [
        { id: 'error', label: 'Error', tone: 'error', value: state.reason },
        ...(state.code === undefined
          ? []
          : [{ id: 'error-code', label: 'Code', tone: 'error' as const, value: state.code }]),
      ];
    case 'stats':
    case 'empty':
    case 'inactive':
    case 'awaiting-observer':
      return [
        ...(state.kind === 'stats' ? recordRows(state) : []),
        { id: 'observer', label: 'Observer', value: observerValue(state, state.models) },
        { id: 'embedder', label: 'Embedder', value: embedderValue(state.models) },
      ];
    case 'chat-only':
    case 'loading':
    case 'withheld':
      return null;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The state's rows, then when it was read: the record's flags hold as of that read. */
function panelRows(state: OmMeterState): PanelRow[] | null {
  const rows = stateRows(state);
  if (!rows) {
    return null;
  }
  return state.readAt === undefined
    ? rows
    : [...rows, { id: 'read-at', label: 'As of', value: storedTime(state.readAt) }];
}

export const MemoryDeveloperPanel = ({ state }: { readonly state: OmMeterState }) => {
  const headingId = useId();
  const rows = panelRows(state);
  if (!rows) {
    return null;
  }
  return (
    <section
      aria-labelledby={headingId}
      className="mt-1.5 border-border/60 border-t pt-1.5 text-[11px]"
      data-testid="context-usage-memory-panel"
    >
      <h4 className="font-medium text-muted-foreground" id={headingId}>
        Memory
      </h4>
      <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-px">
        {rows.map((row) => (
          <div className="contents" data-testid={`context-usage-memory-${row.id}`} key={row.id}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              className={
                row.tone === 'error'
                  ? 'break-words text-destructive'
                  : 'break-words text-foreground tabular-nums'
              }
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

MemoryDeveloperPanel.displayName = 'MemoryDeveloperPanel';
