import type {
  InspectCommandSessionsInput,
  ManageCommandSessionInput,
  RuntimeData,
} from '@brainstrike/agent';
import {
  COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS,
  type CommandSessionInfo,
  type CommandSessionManager,
  type CommandSessionRead,
  getDesktopCommandSessionManager,
} from './command-session-manager';
import { resolveWorkspaceRoot } from './workspace-roots';

export interface CommandSessionToolDependencies {
  readonly manager?: CommandSessionManager;
}

type InspectCommandSessionsResult =
  | (CommandSessionRead & { readonly session: CommandSessionInfo })
  | { readonly rootId: string; readonly sessions: readonly CommandSessionInfo[] };

type ManageCommandSessionResult =
  | CommandSessionInfo
  | { readonly id: string; readonly removed: true; readonly rootId: string }
  | { readonly session: CommandSessionInfo; readonly writtenUtf16CodeUnits: number };

function resolveManager(dependencies: CommandSessionToolDependencies): CommandSessionManager {
  return dependencies.manager ?? getDesktopCommandSessionManager();
}

function resolveRootId(runtimeData: RuntimeData | undefined, root: string | undefined): string {
  return resolveWorkspaceRoot(runtimeData, root).rootId;
}

function unsupportedOperation(operation: never): never {
  throw new Error(`Unsupported command-session action: ${JSON.stringify(operation)}`);
}

export function runInspectCommandSessions(
  input: InspectCommandSessionsInput,
  runtimeData: RuntimeData | undefined,
  dependencies: CommandSessionToolDependencies = {}
): InspectCommandSessionsResult {
  const manager = resolveManager(dependencies);
  const rootId = resolveRootId(runtimeData, input.root);
  if (input.operation.action === 'list') {
    return { rootId, sessions: manager.list(rootId) };
  }
  const read = manager.read(
    rootId,
    input.operation.sessionId,
    input.operation.cursor,
    COMMAND_SESSION_READ_PAGE_UTF16_CODE_UNITS
  );
  return { ...read, session: manager.get(rootId, input.operation.sessionId) };
}

export async function runManageCommandSession(
  input: ManageCommandSessionInput,
  runtimeData: RuntimeData | undefined,
  dependencies: CommandSessionToolDependencies & { readonly signal?: AbortSignal } = {}
): Promise<ManageCommandSessionResult> {
  const manager = resolveManager(dependencies);
  const rootId = resolveRootId(runtimeData, input.root);
  const operation = input.operation;
  if (operation.action === 'start') {
    return await manager.start({
      command: operation.command,
      rootId,
      ...(operation.cols === undefined ? {} : { cols: operation.cols }),
      ...(operation.cwd === undefined ? {} : { cwd: operation.cwd }),
      ...(operation.rows === undefined ? {} : { rows: operation.rows }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });
  }
  if (operation.action === 'write') {
    manager.write(rootId, operation.sessionId, operation.data);
    return {
      session: manager.get(rootId, operation.sessionId),
      writtenUtf16CodeUnits: operation.data.length,
    };
  }
  if (operation.action === 'stop') {
    await manager.stop(rootId, operation.sessionId);
    return manager.get(rootId, operation.sessionId);
  }
  if (operation.action === 'remove') {
    await manager.remove(rootId, operation.sessionId);
    return { id: operation.sessionId, removed: true as const, rootId };
  }
  return unsupportedOperation(operation);
}
