import { refusalError } from '@brainstrike/assistant-contract';
import {
  changesThreadWorkspaceScope,
  type ThreadWorkspaceBinding,
  ThreadWorkspaceBindingSchema,
} from '@brainstrike/assistant-contract/thread-workspace-binding';
import { mergeAssistantThreadMetadata } from '@brainstrike/assistant-data/assistant-thread-metadata-merge';
import { Schema } from 'effect';
import {
  acceptHostWorkspaceSnapshot,
  type HostRunState,
  readHostWorkspaceSnapshot,
} from './core-state.ts';
import { canonical, jsonValue } from './json-value.ts';
import type { HostPlatform, HostRunAdmission, HostRunAdmissionRequest } from './ports.ts';
import type { HostEvent, HostLogRow, HostParams } from './protocol.ts';
import { foldHostWorktreeEntry } from './worktree-binding.ts';
/** In-memory projections of Core's existing thread log; owns no writer or queue. */
export class HostThreadWorkspaceState {
  private readonly snapshots = new Map<string, HostParams<'thread/workspace/set'>['snapshot']>();
  private readonly bindings = new Map<string, ThreadWorkspaceBinding>();
  constructor(
    private readonly commit: (
      method: 'thread/workspace/set' | 'thread/workspace/binding/update',
      params: HostParams<'thread/workspace/set'> | HostParams<'thread/workspace/binding/update'>,
      event: Extract<
        HostEvent,
        {
          type: 'workspace.updated' | 'workspace.binding.updated';
        }
      >,
      durability: 'normal' | 'full'
    ) => Promise<void>
  ) {}
  /** The binding, and the run its commit names as having moved the thread (ADR-0028). */
  fold(row: HostLogRow, runs: ReadonlyMap<string, HostRunState>): void {
    if (row.event.type === 'workspace.updated') {
      this.snapshots.set(row.threadId, row.event.snapshot);
    } else if (row.event.type === 'workspace.binding.updated') {
      this.bindings.set(row.threadId, row.event.binding);
      foldHostWorktreeEntry(runs, row.event);
    }
  }
  forget(threadId: string): void {
    this.snapshots.delete(threadId);
    this.bindings.delete(threadId);
  }
  readSnapshot(threads: ReadonlySet<string>, threadId: string) {
    return readHostWorkspaceSnapshot(threads, this.snapshots, threadId);
  }
  readBinding(
    threads: ReadonlySet<string>,
    threadId: string
  ): {
    binding: ThreadWorkspaceBinding | null;
  } {
    if (!threads.has(threadId)) {
      throw refusalError('input', 'thread.unknown', 'Unknown thread');
    }
    return { binding: structuredClone(this.bindings.get(threadId) ?? null) };
  }
  admissionBinding(threadId: string): Pick<HostRunAdmissionRequest, 'workspaceBinding'> {
    const binding = this.bindings.get(threadId);
    return binding ? { workspaceBinding: structuredClone(binding) } : {};
  }
  setSnapshot(
    params: HostParams<'thread/workspace/set'>,
    threads: ReadonlySet<string>
  ): Promise<{
    accepted: true;
  }> {
    return acceptHostWorkspaceSnapshot(params, threads, (event) =>
      this.commit('thread/workspace/set', params, event, 'normal')
    );
  }
  async setBinding(
    params: HostParams<'thread/workspace/binding/update'>,
    platform: HostPlatform,
    pending: Map<AbortController, string>,
    /** Core's own worktree entry (ADR-0028); a client's binding update never names a run. */
    enteredBy?: { readonly runId: string }
  ): Promise<{
    accepted: true;
  }> {
    const binding = Schema.decodeUnknownSync(ThreadWorkspaceBindingSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(mergeAssistantThreadMetadata(this.bindings.get(params.threadId), params.patch));
    const controller = new AbortController();
    pending.set(controller, params.threadId);
    try {
      if (changesThreadWorkspaceScope(params.patch)) {
        if (!platform.validateWorkspaceBinding) {
          throw new Error('This host has no live thread workspace binding capability');
        }
        await platform.validateWorkspaceBinding({
          binding,
          signal: controller.signal,
          threadId: params.threadId,
        });
      }
      controller.signal.throwIfAborted();
      await this.commit(
        'thread/workspace/binding/update',
        params,
        { binding, ...(enteredBy ? { enteredBy } : {}), type: 'workspace.binding.updated' },
        'full'
      );
      return { accepted: true };
    } finally {
      pending.delete(controller);
    }
  }
}
/** Join the live existing catalog/registry before either new or recovered admission. */
export async function validateHostRunWorkspaceBinding(
  platform: HostPlatform,
  request: HostRunAdmissionRequest
): Promise<void> {
  const binding = request.workspaceBinding;
  if (!(binding && changesThreadWorkspaceScope(binding))) {
    return;
  }
  if (!platform.validateWorkspaceBinding) {
    throw new Error('Run admission has no live thread workspace binding capability');
  }
  await platform.validateWorkspaceBinding({
    binding,
    runId: request.runId,
    signal: request.signal,
    threadId: request.threadId,
  });
  request.signal.throwIfAborted();
}
/** Only Core supplies this capture; a platform cannot replace or discard its root. */
export function bindHostRunWorkspace(
  selected: HostRunAdmission,
  request: HostRunAdmissionRequest
): HostRunAdmission {
  const binding = request.workspaceBinding;
  if (
    selected.snapshot.workspaceBinding &&
    canonical(jsonValue(selected.snapshot.workspaceBinding)) !==
      canonical(jsonValue(binding ?? null))
  ) {
    throw new Error('The platform attempted to replace the Core-owned workspace binding');
  }
  if (
    binding?.operatingRootId &&
    selected.configuration.boundWorkspaceRootId !== binding.operatingRootId
  ) {
    throw new Error('Run admission did not retain the Core-owned operating root');
  }
  return {
    ...selected,
    snapshot: { ...selected.snapshot, ...(binding ? { workspaceBinding: binding } : {}) },
  };
}
