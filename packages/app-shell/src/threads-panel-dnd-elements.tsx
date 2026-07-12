import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ThreadsPanelDragSource, ThreadsPanelDropTarget } from './threads-panel-dnd';

/**
 * Pragmatic drag and drop element wiring for the Threads panel. These shells
 * only translate DOM drag events into the plain source/target records that
 * `resolveThreadsPanelDrop` consumes; nothing here talks to a store.
 */
const THREADS_PANEL_DND_KEY = Symbol('threads-panel-dnd');

type SourceRecord = Record<string | symbol, unknown> & {
  readonly [THREADS_PANEL_DND_KEY]: ThreadsPanelDragSource;
};

type TargetRecord = Record<string | symbol, unknown> & {
  readonly [THREADS_PANEL_DND_KEY]: ThreadsPanelDropTarget;
};

function makeSourceData(source: ThreadsPanelDragSource): SourceRecord {
  return { [THREADS_PANEL_DND_KEY]: source };
}

function makeTargetData(target: ThreadsPanelDropTarget): TargetRecord {
  return { [THREADS_PANEL_DND_KEY]: target };
}

function readSource(data: Record<string | symbol, unknown>): ThreadsPanelDragSource | null {
  const source = data[THREADS_PANEL_DND_KEY];
  return source && typeof source === 'object' && 'type' in source
    ? (source as ThreadsPanelDragSource)
    : null;
}

function readTarget(data: Record<string | symbol, unknown>): ThreadsPanelDropTarget | null {
  const target = data[THREADS_PANEL_DND_KEY];
  return target && typeof target === 'object' && 'type' in target
    ? (target as ThreadsPanelDropTarget)
    : null;
}

function toEdge(value: ReturnType<typeof extractClosestEdge>): 'bottom' | 'top' | null {
  return value === 'top' || value === 'bottom' ? value : null;
}

export function DropEdgeIndicator({ edge }: { readonly edge: 'bottom' | 'top' }): ReactElement {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary ${
        edge === 'top' ? '-top-[3px]' : '-bottom-[3px]'
      }`}
      data-testid="thread-drop-indicator"
    />
  );
}

export function ThreadRowDndShell({
  children,
  groupId,
  threadId,
}: {
  readonly children: ReactNode;
  readonly groupId: string | null;
  readonly threadId: string;
}): ReactElement {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<'bottom' | 'top' | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return combine(
      draggable({
        element,
        getInitialData: () => makeSourceData({ groupId, threadId, type: 'thread-row' }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => readSource(source.data)?.type === 'thread-row',
        element,
        getData: ({ element: targetElement, input }) =>
          attachClosestEdge(
            makeTargetData({ edge: 'bottom', groupId, threadId, type: 'thread-row' }),
            {
              allowedEdges: ['top', 'bottom'],
              element: targetElement,
              input,
            }
          ),
        onDrag: ({ self, source }) => {
          const sourceData = readSource(source.data);
          if (sourceData?.type === 'thread-row' && sourceData.threadId === threadId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(toEdge(extractClosestEdge(self.data)));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [groupId, threadId]);

  return (
    <div className={`relative ${isDragging ? 'opacity-50' : ''}`} ref={elementRef}>
      {closestEdge ? <DropEdgeIndicator edge={closestEdge} /> : null}
      {children}
    </div>
  );
}

export function GroupHeaderDndShell({
  children,
  groupId,
}: {
  readonly children: ReactNode;
  readonly groupId: string;
}): ReactElement {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<'bottom' | 'top' | null>(null);
  const [isThreadOver, setIsThreadOver] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return combine(
      draggable({
        element,
        getInitialData: () => makeSourceData({ groupId, type: 'group-header' }),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => readSource(source.data) !== null,
        element,
        getData: ({ element: targetElement, input }) =>
          attachClosestEdge(makeTargetData({ groupId, type: 'group-header' }), {
            allowedEdges: ['top', 'bottom'],
            element: targetElement,
            input,
          }),
        onDrag: ({ self, source }) => {
          const sourceData = readSource(source.data);
          if (!sourceData) {
            return;
          }
          if (sourceData.type === 'thread-row') {
            setIsThreadOver(sourceData.groupId !== groupId);
            setClosestEdge(null);
            return;
          }
          if (sourceData.groupId === groupId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(toEdge(extractClosestEdge(self.data)));
        },
        onDragLeave: () => {
          setClosestEdge(null);
          setIsThreadOver(false);
        },
        onDrop: () => {
          setClosestEdge(null);
          setIsThreadOver(false);
        },
      })
    );
  }, [groupId]);

  return (
    <div
      className={`relative rounded-md ${isDragging ? 'opacity-50' : ''} ${
        isThreadOver ? 'bg-primary/10 ring-1 ring-primary/40' : ''
      }`}
      ref={elementRef}
    >
      {closestEdge ? <DropEdgeIndicator edge={closestEdge} /> : null}
      {children}
    </div>
  );
}

export function UngroupedSectionDndShell({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  const elementRef = useRef<HTMLDivElement>(null);
  const [isThreadOver, setIsThreadOver] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }
    return dropTargetForElements({
      canDrop: ({ source }) => {
        const sourceData = readSource(source.data);
        return sourceData?.type === 'thread-row' && sourceData.groupId !== null;
      },
      element,
      getData: () => makeTargetData({ type: 'ungrouped-section' }),
      onDragEnter: () => setIsThreadOver(true),
      onDragLeave: () => setIsThreadOver(false),
      onDrop: () => setIsThreadOver(false),
    });
  }, []);

  return (
    <div
      className={`rounded-md ${isThreadOver ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}
      ref={elementRef}
    >
      {children}
    </div>
  );
}

/**
 * Panel-level drop monitor. Rows and headers are nested drop targets, so the
 * innermost target under the pointer wins (`dropTargets[0]`); the closest-edge
 * hitbox data attached by that target is folded into the plain target record.
 */
export function useThreadsPanelDropMonitor(
  onPanelDrop: (source: ThreadsPanelDragSource, target: ThreadsPanelDropTarget) => void
): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readSource(source.data) !== null,
        onDrop: ({ location, source }) => {
          const sourceData = readSource(source.data);
          const innermostTarget = location.current.dropTargets[0];
          if (!(sourceData && innermostTarget)) {
            return;
          }
          const targetData = readTarget(innermostTarget.data);
          if (!targetData) {
            return;
          }
          const edge = toEdge(extractClosestEdge(innermostTarget.data));
          onPanelDrop(
            sourceData,
            targetData.type === 'ungrouped-section' || !edge ? targetData : { ...targetData, edge }
          );
        },
      }),
    [onPanelDrop]
  );
}
