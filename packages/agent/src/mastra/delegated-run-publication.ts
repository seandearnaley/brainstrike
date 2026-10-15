import type { DelegatedRunIdentity } from '@brainstrike/assistant-contract/delegated-conversation-stream';
import {
  readMastraStreamPartString,
  readMastraStreamPartValue,
} from '../tool-projection/tool-event-mapper';

export type { DelegatedRunIdentity } from '@brainstrike/assistant-contract/delegated-conversation-stream';

type AuthorizeDelegatedRun = (identity: DelegatedRunIdentity) => Promise<unknown>;

function requireIdentity(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Delegated publication requires observed native run identity.');
  }
  return value;
}

/** Each attempt/resume leg must authorize its first child event from durable host state. */
export function createDelegatedRunPublicationGuard(
  bindRun: AuthorizeDelegatedRun,
  personas: ReadonlyMap<string, string>
): (part: unknown) => Promise<void>;
export function createDelegatedRunPublicationGuard(
  bindRun: AuthorizeDelegatedRun | undefined,
  personas: ReadonlyMap<string, string>
): ((part: unknown) => Promise<void>) | undefined;
export function createDelegatedRunPublicationGuard(
  bindRun: AuthorizeDelegatedRun | undefined,
  personas: ReadonlyMap<string, string>
): ((part: unknown) => Promise<void>) | undefined {
  if (!bindRun) {
    return;
  }
  const authorized = new Map<string, string>();
  return async (part) => {
    if (readMastraStreamPartString(part, 'type') !== 'tool-output') {
      return;
    }
    const toolName = readMastraStreamPartString(part, 'toolName');
    const personaId = toolName ? personas.get(toolName) : undefined;
    if (!personaId) {
      return;
    }
    const output = readMastraStreamPartValue(part, 'output');
    const identity: DelegatedRunIdentity = {
      childRuntimeRunId: requireIdentity(readMastraStreamPartString(output, 'runId')),
      parentRuntimeRunId: requireIdentity(readMastraStreamPartString(part, 'runId')),
      parentToolCallId: requireIdentity(readMastraStreamPartString(part, 'toolCallId')),
      personaId,
    };
    const key = JSON.stringify([identity.parentRuntimeRunId, identity.parentToolCallId]);
    const existing = authorized.get(key);
    if (existing !== undefined) {
      if (existing !== identity.childRuntimeRunId) {
        throw new Error('Delegated publication changed its native child run identity.');
      }
      return;
    }
    await bindRun(identity);
    authorized.set(key, identity.childRuntimeRunId);
  };
}
