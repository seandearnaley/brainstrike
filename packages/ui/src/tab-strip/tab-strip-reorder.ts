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
import { useEventCallback } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import { type RefObject, useEffect, useId, useState } from 'react';
import { resolveTabDropOrder, type TabEdge } from './tab-strip-order';

const logger = createLogger('TabStripReorder');
const TAB_REORDER_KEY = Symbol('tab-strip-reorder');

interface TabReorderData {
  readonly id: string;
  readonly instanceId: string;
}

type DragRecord = Record<string | symbol, unknown>;

function makeReorderData(instanceId: string, id: string): DragRecord {
  const data: TabReorderData = { id, instanceId };
  return { [TAB_REORDER_KEY]: data };
}

function readReorderData(data: DragRecord): TabReorderData | null {
  const value = data[TAB_REORDER_KEY];
  if (!(value && typeof value === 'object')) {
    return null;
  }
  if (!('id' in value && typeof value.id === 'string')) {
    return null;
  }
  if (!('instanceId' in value && typeof value.instanceId === 'string')) {
    return null;
  }
  return { id: value.id, instanceId: value.instanceId };
}

function toEdge(value: ReturnType<typeof extractClosestEdge>): TabEdge | null {
  return value === 'left' || value === 'right' ? value : null;
}

/** Strip-scoped drag identity: a drag from one strip is never a drop for another. */
export function useTabReorderInstanceId(enabled: boolean): string | null {
  const instanceId = useId();
  return enabled ? instanceId : null;
}

export function useTabReorderItem({
  handleRef,
  id,
  instanceId,
  shellRef,
}: {
  readonly handleRef: RefObject<HTMLElement | null>;
  readonly id: string;
  readonly instanceId: string | null;
  readonly shellRef: RefObject<HTMLElement | null>;
}): { readonly closestEdge: TabEdge | null; readonly isDragging: boolean } {
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<TabEdge | null>(null);

  useEffect(() => {
    const element = shellRef.current;
    const dragHandle = handleRef.current;
    if (!(instanceId && element && dragHandle)) {
      return;
    }
    return combine(
      draggable({
        dragHandle,
        element,
        getInitialData: () => makeReorderData(instanceId, id),
        onDragStart: () => setIsDragging(true),
        onDrop: () => setIsDragging(false),
      }),
      dropTargetForElements({
        canDrop: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
        element,
        getData: ({ element: target, input }) =>
          attachClosestEdge(makeReorderData(instanceId, id), {
            allowedEdges: ['left', 'right'],
            element: target,
            input,
          }),
        onDrag: ({ self, source }) => {
          setClosestEdge(
            readReorderData(source.data)?.id === id ? null : toEdge(extractClosestEdge(self.data))
          );
        },
        onDragLeave: () => setClosestEdge(null),
        onDrop: () => setClosestEdge(null),
      })
    );
  }, [handleRef, id, instanceId, shellRef]);

  return { closestEdge, isDragging };
}

export function useTabStripReorderMonitor({
  instanceId,
  onReorder,
  orderedIds,
  scrollRef,
}: {
  readonly instanceId: string | null;
  readonly onReorder: ((orderedIds: readonly string[]) => void) | undefined;
  readonly orderedIds: readonly string[];
  readonly scrollRef: RefObject<HTMLElement | null>;
}): void {
  const handleDrop = useEventCallback((sourceId: string, targetId: string, edge: TabEdge): void => {
    const resolution = resolveTabDropOrder({ edge, orderedIds, sourceId, targetId });
    if (resolution.kind === 'stale') {
      logger.warn('Ignored a tab drop whose tab is no longer open', {
        missingId: resolution.missingId,
      });
      return;
    }
    if (resolution.kind === 'reorder') {
      onReorder?.(resolution.orderedIds);
    }
  });

  useEffect(() => {
    if (!instanceId) {
      return;
    }
    return monitorForElements({
      canMonitor: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
      onDrop: ({ location, source }) => {
        const sourceData = readReorderData(source.data);
        const target = location.current.dropTargets[0];
        if (!(sourceData && target)) {
          return;
        }
        const targetData = readReorderData(target.data);
        const edge = toEdge(extractClosestEdge(target.data));
        if (!(targetData && edge)) {
          return;
        }
        handleDrop(sourceData.id, targetData.id, edge);
      },
    });
  }, [handleDrop, instanceId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!(instanceId && element)) {
      return;
    }
    return autoScrollForElements({
      canScroll: ({ source }) => readReorderData(source.data)?.instanceId === instanceId,
      element,
      getAllowedAxis: () => 'horizontal',
    });
  }, [instanceId, scrollRef]);
}
