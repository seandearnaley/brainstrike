import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import {
  attachClosestEdge,
  extractClosestEdge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type AssistantThreadTabDragSource,
  type AssistantThreadTabDropTarget,
  resolveAssistantThreadTabDrop,
} from './assistant-thread-tabs-dnd';

const ASSISTANT_THREAD_TAB_DND_KEY = Symbol('assistant-thread-tab-dnd');

type SourceRecord = Record<string | symbol, unknown> & {
  readonly [ASSISTANT_THREAD_TAB_DND_KEY]: AssistantThreadTabDragSource;
};

type TargetRecord = Record<string | symbol, unknown> & {
  readonly [ASSISTANT_THREAD_TAB_DND_KEY]: AssistantThreadTabDropTarget;
};

function makeSourceData(threadId: string): SourceRecord {
  return {
    [ASSISTANT_THREAD_TAB_DND_KEY]: { threadId, type: 'assistant-thread-tab' },
  };
}

function makeTargetData(threadId: string): TargetRecord {
  return {
    [ASSISTANT_THREAD_TAB_DND_KEY]: {
      edge: 'right',
      threadId,
      type: 'assistant-thread-tab',
    },
  };
}

function readSource(data: Record<string | symbol, unknown>): AssistantThreadTabDragSource | null {
  const source = data[ASSISTANT_THREAD_TAB_DND_KEY];
  if (!(source && typeof source === 'object')) {
    return null;
  }
  if (!('type' in source && source.type === 'assistant-thread-tab')) {
    return null;
  }
  if (!('threadId' in source && typeof source.threadId === 'string')) {
    return null;
  }
  return { threadId: source.threadId, type: 'assistant-thread-tab' };
}

function readTarget(data: Record<string | symbol, unknown>): AssistantThreadTabDropTarget | null {
  const target = data[ASSISTANT_THREAD_TAB_DND_KEY];
  if (!(target && typeof target === 'object')) {
    return null;
  }
  if (!('type' in target && target.type === 'assistant-thread-tab')) {
    return null;
  }
  if (!('threadId' in target && typeof target.threadId === 'string')) {
    return null;
  }
  const edge = 'edge' in target ? target.edge : null;
  if (!(edge === 'left' || edge === 'right')) {
    return null;
  }
  return { edge, threadId: target.threadId, type: 'assistant-thread-tab' };
}

function toHorizontalEdge(value: ReturnType<typeof extractClosestEdge>): 'left' | 'right' | null {
  return value === 'left' || value === 'right' ? value : null;
}

export function AssistantThreadTabDndShell({
  children,
  threadId,
}: {
  readonly children: (dragHandleRef: RefObject<HTMLButtonElement | null>) => ReactNode;
  readonly threadId: string;
}): ReactElement {
  const elementRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLButtonElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    const dragHandle = dragHandleRef.current;
    if (!(element && dragHandle)) {
      return;
    }
    return combine(
      draggable({
        dragHandle,
        element,
        getInitialData: () => makeSourceData(threadId),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => readSource(source.data) !== null,
        element,
        getData: ({ element: targetElement, input }) =>
          attachClosestEdge(makeTargetData(threadId), {
            allowedEdges: ['left', 'right'],
            element: targetElement,
            input,
          }),
        onDrag: ({ self, source }) => {
          const sourceData = readSource(source.data);
          if (!sourceData || sourceData.threadId === threadId) {
            setClosestEdge(null);
            return;
          }
          setClosestEdge(toHorizontalEdge(extractClosestEdge(self.data)));
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [threadId]);

  return (
    <div
      className={`relative min-w-32 max-w-64 flex-[1_1_10rem] transition-opacity duration-150 motion-reduce:transition-none ${
        isDragging ? 'opacity-45' : 'opacity-100'
      }`}
      data-dragging={isDragging ? 'true' : 'false'}
      ref={elementRef}
      role="presentation"
    >
      {closestEdge ? <AssistantThreadTabDropIndicator edge={closestEdge} /> : null}
      {children(dragHandleRef)}
    </div>
  );
}

export function AssistantThreadTabDropIndicator({
  edge,
}: {
  readonly edge: 'left' | 'right';
}): ReactElement {
  return (
    <span
      className={`pointer-events-none absolute inset-y-0 z-20 w-0.5 rounded-full bg-primary shadow-[0_0_0_1px_var(--background)] ${
        edge === 'left' ? '-left-[3px]' : '-right-[3px]'
      }`}
      data-edge={edge}
      data-testid="assistant-thread-tab-drop-indicator"
    />
  );
}

export function useAssistantThreadTabAutoScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  registrationVersion: number
): void {
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    return autoScrollForElements({
      canScroll: ({ source }) => readSource(source.data) !== null,
      element,
    });
  }, [registrationVersion, scrollRef]);
}

export function useAssistantThreadTabDropMonitor({
  onReorder,
  openThreadIds,
}: {
  readonly onReorder: (orderedThreadIds: readonly string[]) => void;
  readonly openThreadIds: readonly string[];
}): void {
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
          const edge = toHorizontalEdge(extractClosestEdge(innermostTarget.data));
          if (!(targetData && edge)) {
            return;
          }
          const intent = resolveAssistantThreadTabDrop({
            openThreadIds,
            source: sourceData,
            target: { ...targetData, edge },
          });
          if (intent.kind === 'none') {
            return;
          }
          onReorder(intent.orderedThreadIds);
        },
      }),
    [onReorder, openThreadIds]
  );
}
