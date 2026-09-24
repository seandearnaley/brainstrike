import type { useAssistantServerRunSession } from './use-assistant-server-run-session';

type ServerRunSession = ReturnType<typeof useAssistantServerRunSession>;

export function requestResourceId(
  requestData: Record<string, unknown> | undefined
): string | undefined {
  const memory = requestData?.['memory'];
  if (!(memory && typeof memory === 'object' && !Array.isArray(memory))) {
    return;
  }
  const resourceId = (memory as Record<string, unknown>)['resourceId'];
  return typeof resourceId === 'string' ? resourceId : undefined;
}

export function isAssistantRecoveryBlocked(session: ServerRunSession): boolean {
  return session.isRecovering || Boolean(session.recoveryError);
}

export function replayRuntimeOptions(session: ServerRunSession) {
  return {
    ...(session.activeRunSession && session.replayEligible && !isAssistantRecoveryBlocked(session)
      ? { activeRunSession: session.activeRunSession }
      : {}),
    ...(session.discoveredRun ? { discoveredRun: session.discoveredRun } : {}),
  };
}
