import type { ManageCanvasInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  applyUpdate,
  type CanvasDatabase,
  type CanvasMutationResult,
  type CanvasRepositoryFailure,
  type CanvasVersion,
  createCanvas,
  listCanvasesForThread,
  rewriteCanvas,
} from './canvas-repository';

export type { CanvasDatabase } from './canvas-repository';

export const MANAGE_CANVAS_TOOL_ID = NATIVE_TOOL_ID.manageCanvas;

const logger = createLogger('AssistantCanvas');

export interface ManageCanvasDependencies {
  /** Injected DB handle for tests; production resolves the main-process handle. */
  database?: CanvasDatabase;
}

async function resolveDesktopDatabase(): Promise<CanvasDatabase> {
  const { getDatabase } = await import('../db-main');
  return getDatabase();
}

export type ManageCanvasToolResult =
  | CanvasMutationResult
  | CanvasRepositoryFailure
  | { readonly canvases: readonly CanvasVersion[] }
  | { readonly error: string; readonly ok: false };

export async function runManageCanvas(
  input: ManageCanvasInput,
  runtimeData: RuntimeData | undefined,
  dependencies: ManageCanvasDependencies = {}
): Promise<ManageCanvasToolResult> {
  const threadId = runtimeData?.memory?.threadId;
  const resourceId = runtimeData?.memory?.resourceId;
  if (!(threadId && resourceId)) {
    logger.warn('manageCanvas called without an active memory thread');
    return { error: 'manageCanvas requires an active memory thread.', ok: false };
  }

  const db = dependencies.database ?? (await resolveDesktopDatabase());
  switch (input.action) {
    case 'create':
      return await createCanvas(db, {
        createdBy: 'assistant',
        html: input.html,
        resourceId,
        threadId,
        title: input.title,
      });
    case 'update':
      return await applyUpdate(db, input);
    case 'rewrite':
      return await rewriteCanvas(db, input);
    case 'list':
      return { canvases: await listCanvasesForThread(db, threadId) };
  }
}
