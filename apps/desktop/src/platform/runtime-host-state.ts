import type { BackgroundRuntimeStatus } from '@brainstrike/worker-runtime';

export type RuntimeHostPlatformState =
  | 'active'
  | 'disposed'
  | 'failed'
  | 'idle'
  | 'ready'
  | 'resetting'
  | 'restarting'
  | 'starting'
  | 'stopped'
  | 'stopping';

export type RuntimeHostControlState = 'disposed' | 'resetting' | 'restarting';

export interface RuntimeHostPlatformStatus<TRuntimeKind extends string> {
  readonly active: boolean;
  readonly lastError: string | null;
  readonly pendingRequestCount: number;
  readonly runtimeId: string;
  readonly runtimeKind: TRuntimeKind;
  readonly sourceState: BackgroundRuntimeStatus<TRuntimeKind>['state'];
  readonly state: RuntimeHostPlatformState;
}

export interface CreateRuntimeHostPlatformStatusOptions {
  readonly controlState?: RuntimeHostControlState;
  readonly inactiveRunningState?: Extract<RuntimeHostPlatformState, 'idle' | 'ready'>;
  readonly pendingRequestCount?: number;
}

export function deriveRuntimeHostPlatformState<TRuntimeKind extends string>(
  status: BackgroundRuntimeStatus<TRuntimeKind>,
  options: CreateRuntimeHostPlatformStatusOptions = {}
): RuntimeHostPlatformState {
  if (options.controlState) {
    return options.controlState;
  }

  switch (status.state) {
    case 'error':
      return 'failed';
    case 'running':
      return status.active ? 'active' : (options.inactiveRunningState ?? 'idle');
    case 'starting':
      return 'starting';
    case 'stopped':
      return 'stopped';
    case 'stopping':
      return 'stopping';
  }
}

export function createRuntimeHostPlatformStatus<TRuntimeKind extends string>(
  status: BackgroundRuntimeStatus<TRuntimeKind>,
  options: CreateRuntimeHostPlatformStatusOptions = {}
): RuntimeHostPlatformStatus<TRuntimeKind> {
  return {
    active: status.active,
    lastError: status.lastError,
    pendingRequestCount: options.pendingRequestCount ?? 0,
    runtimeId: status.runtimeId,
    runtimeKind: status.runtimeKind,
    sourceState: status.state,
    state: deriveRuntimeHostPlatformState(status, options),
  };
}
