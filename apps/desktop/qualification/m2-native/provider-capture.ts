import {
  type ModelProviderRequest,
  type ModelProviderScript,
  type ModelProviderScriptSelector,
  type ModelProviderShim,
  startModelProviderShim,
} from '../../e2e/utils/model-provider-shim.ts';

export function toolMessages(request: ModelProviderRequest): readonly unknown[] {
  const lastUser = request.messages.findLastIndex(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'user'
  );
  return request.messages
    .slice(lastUser + 1)
    .filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'tool'
    );
}

export interface CapturingProvider extends ModelProviderShim {
  readonly lastRequest: () => ModelProviderRequest | undefined;
  readonly outputs: () => readonly unknown[];
}

export async function startCapturingProvider(
  initialScript: ModelProviderScript | ModelProviderScriptSelector
): Promise<CapturingProvider> {
  let selected = initialScript;
  let outputs: readonly unknown[] = [];
  let lastRequest: ModelProviderRequest | undefined;
  const provider = await startModelProviderShim((request) => {
    if (request.toolNames.length === 0) {
      return { finalText: 'M2 native tool qualification' };
    }
    outputs = toolMessages(request);
    lastRequest = request;
    return typeof selected === 'function' ? selected(request) : selected;
  });
  return {
    ...provider,
    lastRequest: () => lastRequest,
    outputs: () => outputs,
    // Keep the observing selector installed across every exercise script switch.
    setScript: (script) => {
      selected = script;
    },
  };
}
