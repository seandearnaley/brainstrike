import { ToolInputError } from '@brainstrike/assistant-contract';
import { isWithinRoot } from './workspace-path';

interface LeaseRequest {
  readonly grant: (release: () => void) => void;
  readonly mode: 'files' | 'opaque';
  readonly reject: (reason: unknown) => void;
  removeAbortListener: () => void;
  readonly rootPath: string;
  readonly sessionId?: string | undefined;
}

const active = new Set<LeaseRequest>();
const pending: LeaseRequest[] = [];

function conflicts(a: LeaseRequest, b: LeaseRequest): boolean {
  return (
    (a.mode === 'opaque' || b.mode === 'opaque') &&
    (isWithinRoot(a.rootPath, b.rootPath) || isWithinRoot(b.rootPath, a.rootPath))
  );
}

function drain(): void {
  const waiting: LeaseRequest[] = [];
  for (const request of pending.splice(0)) {
    const session = [...active].find((other) => other.sessionId && conflicts(request, other));
    if (session) {
      request.removeAbortListener();
      request.reject(
        new ToolInputError(
          `Workspace is held by delegated command session "${session.sessionId}". Edits and other writers must wait for that process to exit.`
        )
      );
      continue;
    }
    if ([...active, ...waiting].some((other) => conflicts(request, other))) {
      waiting.push(request);
      continue;
    }
    active.add(request);
    request.removeAbortListener();
    let released = false;
    request.grant(() => {
      if (released) {
        return;
      }
      released = true;
      active.delete(request);
      drain();
    });
  }
  pending.push(...waiting);
}

/** Canonical roots come from the existing containment resolver. File tools keep
 * their per-path locks; opaque processes exclude all file mutations in an
 * overlapping root for their entire execution lifetime. This coordinates the
 * declared workspace, not a shell sandbox or remote MCP server filesystem. */
export function acquireWorkspaceMutationLease(
  rootPath: string,
  mode: LeaseRequest['mode'],
  signal?: AbortSignal,
  sessionId?: string
): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((grant, reject) => {
    const request: LeaseRequest = {
      grant,
      mode,
      reject,
      removeAbortListener: () => {},
      rootPath,
      sessionId,
    };
    const abort = () => {
      const index = pending.indexOf(request);
      if (index < 0) {
        return;
      }
      pending.splice(index, 1);
      request.removeAbortListener();
      reject(signal?.reason);
      drain();
    };
    request.removeAbortListener = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    pending.push(request);
    drain();
  });
}

export async function withWorkspaceMutationLease<T>(
  rootPath: string,
  mode: LeaseRequest['mode'],
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release = await acquireWorkspaceMutationLease(rootPath, mode, signal);
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    release();
  }
}
