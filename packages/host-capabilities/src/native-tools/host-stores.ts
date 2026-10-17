import { randomUUID } from 'node:crypto';
import { ASSISTANT_TASK_STATUSES, type AssistantTaskItem } from '@brainstrike/agent';
import { buildCurrentTaskListNote } from '@brainstrike/agent/tool-runtime';
import type { HostToolState } from '@brainstrike/agent-host';
import { canvasHtmlWithinByteCeiling, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
import {
  CANVAS_STATE_KEY_PREFIX,
  canvasStateKey,
  HostCanvasVersionSchema,
} from './canvas-state.js';
import {
  CANVAS_LIST_LIMIT,
  type CanvasMutationResult,
  type CanvasRepositoryFailure,
  type CanvasStore,
  type CanvasVersion,
  type TaskListStore,
} from './ports.js';

/**
 * The host's thread-scoped stores: Core's `tool.state.updated` rows, one key
 * per task list and per canvas. Restart folds them back from the run log and
 * thread deletion erases them with it; there is no other record.
 */
const TASK_LIST_KEY = NATIVE_TOOL_ID.manageTaskList;
const TaskItemsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      activeForm: Schema.String,
      content: Schema.String,
      id: Schema.String,
      status: Schema.Literals(ASSISTANT_TASK_STATUSES),
    })
  )
);
/** The legacy `<current-task-list>` note over the thread's committed list. */
export function hostTaskListNote(state: Pick<HostToolState, 'read'>): string | undefined {
  const current = state.read(TASK_LIST_KEY);
  return (
    buildCurrentTaskListNote(
      current === undefined
        ? undefined
        : wireDecoder(TaskItemsSchema, { errors: 'all', onExcessProperty: 'error' })(current)
    ) ?? undefined
  );
}

export function hostTaskListStore(state: HostToolState): TaskListStore {
  return {
    replace: async (next) => {
      let stored: AssistantTaskItem[] = [];
      await state.update(TASK_LIST_KEY, (current) => {
        stored = next(
          current === undefined
            ? []
            : wireDecoder(TaskItemsSchema, { errors: 'all', onExcessProperty: 'error' })(current)
        );
        return wireDecoder(TaskItemsSchema, { errors: 'all', onExcessProperty: 'error' })(stored);
      });
      return stored;
    },
  };
}

export function hostCanvasStore(state: HostToolState): CanvasStore {
  const key = (canvasId: string) => canvasStateKey(canvasId);
  const store = async (
    canvasId: string,
    next: (latest: CanvasVersion | undefined) => CanvasVersion | CanvasRepositoryFailure
  ): Promise<CanvasMutationResult> => {
    let result: CanvasMutationResult = { error: 'not_found', ok: false };
    await state.update(key(canvasId), (current) => {
      const version = next(
        current === undefined
          ? undefined
          : wireDecoder(HostCanvasVersionSchema, { errors: 'all', onExcessProperty: 'error' })(
              current
            )
      );
      if ('ok' in version) {
        result = version;
        return;
      }
      // The ceiling is enforced where html is stored, like the legacy repository.
      if (!canvasHtmlWithinByteCeiling(version.html)) {
        result = { error: 'too_large', ok: false };
        return;
      }
      result = { canvasId: version.canvasId, version: version.version };
      return version;
    });
    return result;
  };
  return {
    create: (input) => {
      const canvasId = randomUUID();
      return store(canvasId, () => ({
        canvasId,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
        html: input.html,
        title: input.title,
        version: 1,
      }));
    },
    list: () => {
      const latest = state
        .entries(CANVAS_STATE_KEY_PREFIX)
        .map(([, value]) =>
          wireDecoder(HostCanvasVersionSchema, { errors: 'all', onExcessProperty: 'error' })(value)
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return Promise.resolve({
        canvases: latest.slice(0, CANVAS_LIST_LIMIT).map((canvas) => ({
          canvasId: canvas.canvasId,
          createdAt: canvas.createdAt,
          title: canvas.title,
          version: canvas.version,
        })),
        truncated: latest.length > CANVAS_LIST_LIMIT,
      });
    },
    revise: (canvasId, next) =>
      store(canvasId, (latest) => {
        if (!latest) {
          return { error: 'not_found', ok: false };
        }
        const html = next(latest);
        if (typeof html !== 'string') {
          return html;
        }
        return {
          canvasId,
          createdAt: new Date().toISOString(),
          createdBy: 'assistant',
          html,
          title: latest.title,
          version: latest.version + 1,
        };
      }),
  };
}
